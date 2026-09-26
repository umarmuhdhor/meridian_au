import type { AppContext } from "../tools/context.js";
import type { InboundMessage } from "../../ports/telegram-inbound.js";
import type { LLMClient } from "../../ports/llm-client.js";
import type { Scheduler } from "../../ports/scheduler.js";
import type { ToolRegistry } from "../tools/registry.js";
import { runAgentLoop } from "../agent/loop.js";
import { buildSystemPrompt } from "../../domain/prompt/builder.js";
import { GENERAL_TOOLS } from "../../domain/prompt/role-tools.js";
import { runBriefingCycle } from "../briefing/cycle.js";
import { closeViaTool } from "../tools/close-via-tool.js";

export interface TelegramRouterDeps {
  ctx: AppContext;
  llm: LLMClient;
  registry: ToolRegistry;
  model: string;
  /** Optional cron-control surface. When absent, `/pause` and `/resume` reply with a note. */
  scheduler?: Scheduler;
  /** Optional graceful shutdown. When absent, `/stop` replies with a note. */
  shutdown?: (reason: string) => void;
  /**
   * Whether real chain writes are armed (MERIDIAN_WRITE_UNSAFE=true). When false,
   * `/close /closeall /deploy` refuse without ever calling the chain — the operator
   * needs to explicitly opt in at boot before mutating commands land here.
   */
  writesEnabled?: boolean;
}

function computeDeployAmountSol(
  walletSol: number,
  cfg: { deployAmountSol: number; gasReserve: number; positionSizePct: number },
): number {
  const available = Math.max(0, walletSol - cfg.gasReserve);
  // `deployAmountSol` is the per-position size; `positionSizePct * available` acts as
  // the wallet-fraction cap so a small wallet still gets sized down.
  const capped = Math.min(cfg.deployAmountSol, available * cfg.positionSizePct);
  return Math.round(Math.max(0, capped) * 100) / 100;
}

/**
 * Dispatch an inbound Telegram message. Read-only commands (/help /status /positions /
 * /wallet /briefing) run direct handlers. Cron-control commands (/pause /resume /stop)
 * run when deps supply a scheduler / shutdown hook. Mutating on-chain commands
 * (/close /closeall /deploy) run behind the `writesEnabled` gate. Anything else is
 * a GENERAL agent tick.
 */
export async function routeTelegramMessage(
  deps: TelegramRouterDeps,
  msg: InboundMessage,
): Promise<void> {
  const trimmed = msg.text.trim();
  const [head, ...rest] = trimmed.split(/\s+/);
  const cmd = head?.toLowerCase() ?? "";

  switch (cmd) {
    case "/help":
    case "/start":
      await deps.ctx.notifier.notify(
        "info",
        [
          "Meridian TS — available commands:",
          "  /help      — show this help",
          "  /status    — wallet balance + open positions summary",
          "  /positions — list open positions",
          "  /wallet    — wallet SOL + USD",
          "  /briefing  — send the daily briefing now",
          "  /pause     — suspend cron ticks (positions still tracked)",
          "  /resume    — resume cron ticks",
          "  /stop      — graceful daemon shutdown",
          "  /close <n> — close position by 1-based index from /positions (writes-gated)",
          "  /closeall  — close every open position (writes-gated)",
          "  /deploy <pool> [sol] — open position on <pool> (writes-gated)",
          "",
          "Any free-form message runs a GENERAL agent tick.",
        ].join("\n"),
      );
      return;

    case "/pause": {
      if (!deps.scheduler) {
        await deps.ctx.notifier.notify("info", "Cron control unavailable in this mode.");
        return;
      }
      if (deps.scheduler.isPaused()) {
        await deps.ctx.notifier.notify("info", "Already paused. /resume to continue.");
        return;
      }
      deps.scheduler.pause();
      deps.ctx.logger.info("telegram-router", "cron paused via telegram");
      await deps.ctx.notifier.notify(
        "info",
        "⏸ Cron paused. No new screening/management/health ticks. /resume to continue.",
      );
      return;
    }

    case "/resume": {
      if (!deps.scheduler) {
        await deps.ctx.notifier.notify("info", "Cron control unavailable in this mode.");
        return;
      }
      if (!deps.scheduler.isPaused()) {
        await deps.ctx.notifier.notify("info", "Cron already running.");
        return;
      }
      deps.scheduler.resume();
      deps.ctx.logger.info("telegram-router", "cron resumed via telegram");
      await deps.ctx.notifier.notify("info", "▶️ Cron resumed.");
      return;
    }

    case "/stop": {
      if (!deps.shutdown) {
        await deps.ctx.notifier.notify("info", "Shutdown hook unavailable in this mode.");
        return;
      }
      deps.ctx.logger.info("telegram-router", "shutdown requested via telegram");
      await deps.ctx.notifier.notify("info", "🛑 Shutting down. Goodbye.");
      deps.shutdown("telegram /stop");
      return;
    }

    case "/close": {
      if (!deps.writesEnabled) {
        await deps.ctx.notifier.notify(
          "info",
          "❌ /close refused: chain writes not armed. Set MERIDIAN_WRITE_UNSAFE=true at boot.",
        );
        return;
      }
      const arg = rest[0];
      if (!arg) {
        await deps.ctx.notifier.notify("info", "Usage: /close <n>  (1-based index from /positions)");
        return;
      }
      const idx = Number.parseInt(arg, 10);
      if (!Number.isInteger(idx) || idx < 1) {
        await deps.ctx.notifier.notify("info", `Bad index "${arg}". Expected positive integer.`);
        return;
      }
      const snap = await deps.ctx.chain.getMyPositions({ force: true });
      const target = snap.positions[idx - 1];
      if (!target) {
        await deps.ctx.notifier.notify(
          "info",
          `No position at index ${idx}. Open positions: ${snap.total_positions}.`,
        );
        return;
      }
      deps.ctx.logger.info("telegram-router", "close requested via telegram", {
        position: target.position,
        pair: target.pair,
      });
      await deps.ctx.notifier.notify(
        "info",
        `Closing #${idx} ${target.pair} (${target.position.slice(0, 8)}…)…`,
      );
      try {
        // Via the close_position tool: its post-hooks send the close card, record
        // History, log the decision and consolidate base → SOL.
        const outcome = await closeViaTool(deps.registry, deps.ctx, target.position, "telegram /close", "GENERAL");
        if (!outcome.ok) {
          await deps.ctx.notifier.notify("warn", `⚠️ Close failed: ${outcome.error}`);
        }
      } catch (err) {
        deps.ctx.logger.warn("telegram-router", "close threw", {
          error: err instanceof Error ? err.message : String(err),
        });
        await deps.ctx.notifier.notify(
          "warn",
          `❌ Close failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    case "/closeall": {
      if (!deps.writesEnabled) {
        await deps.ctx.notifier.notify(
          "info",
          "❌ /closeall refused: chain writes not armed. Set MERIDIAN_WRITE_UNSAFE=true at boot.",
        );
        return;
      }
      const snap = await deps.ctx.chain.getMyPositions({ force: true });
      if (snap.total_positions === 0) {
        await deps.ctx.notifier.notify("info", "No open positions to close.");
        return;
      }
      deps.ctx.logger.info("telegram-router", "closeall requested via telegram", {
        count: snap.total_positions,
      });
      await deps.ctx.notifier.notify(
        "info",
        `Closing all ${snap.total_positions} position(s)…`,
      );
      let ok = 0;
      let fail = 0;
      for (const p of snap.positions) {
        try {
          const outcome = await closeViaTool(deps.registry, deps.ctx, p.position, "telegram /closeall", "GENERAL");
          if (outcome.ok) ok += 1;
          else {
            fail += 1;
            deps.ctx.logger.warn("telegram-router", "closeall item failed", {
              position: p.position,
              error: outcome.error,
            });
          }
        } catch (err) {
          fail += 1;
          deps.ctx.logger.warn("telegram-router", "closeall item threw", {
            position: p.position,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await deps.ctx.notifier.notify(
        "info",
        `/closeall done. success=${ok} failed=${fail}`,
      );
      return;
    }

    case "/deploy": {
      if (!deps.writesEnabled) {
        await deps.ctx.notifier.notify(
          "info",
          "❌ /deploy refused: chain writes not armed. Set MERIDIAN_WRITE_UNSAFE=true at boot.",
        );
        return;
      }
      const poolAddress = rest[0];
      if (!poolAddress) {
        await deps.ctx.notifier.notify(
          "info",
          "Usage: /deploy <pool_address> [amount_sol]  (uses config strategy + bins)",
        );
        return;
      }
      let amountOverride: number | null = null;
      if (rest[1] != null) {
        const n = Number.parseFloat(rest[1]);
        if (!Number.isFinite(n) || n <= 0) {
          await deps.ctx.notifier.notify("info", `Bad amount "${rest[1]}". Expected positive number.`);
          return;
        }
        amountOverride = n;
      }
      const wallet = await deps.ctx.chain.getWalletBalance();
      const amountSol =
        amountOverride ??
        computeDeployAmountSol(wallet.sol, deps.ctx.config.management);
      const { strategy, binsBelow } = deps.ctx.config.strategy;
      deps.ctx.logger.info("telegram-router", "deploy requested via telegram", {
        pool_address: poolAddress,
        amount_sol: amountSol,
        strategy,
        bins_below: binsBelow,
      });
      await deps.ctx.notifier.notify(
        "info",
        `Deploying ${amountSol} SOL on ${poolAddress.slice(0, 8)}… (${strategy}, ${binsBelow} bins)…`,
      );
      try {
        const result = await deps.ctx.chain.deployPosition({
          pool_address: poolAddress,
          amount_sol: amountSol,
          strategy,
          bins_below: binsBelow,
          bins_above: 0,
        });
        if (result.success) {
          await deps.ctx.notifier.notify(
            "info",
            `✅ Deployed. position=${result.position_address.slice(0, 8)}… tx=${result.tx ?? "(n/a)"}`,
          );
        } else {
          await deps.ctx.notifier.notify(
            "warn",
            `⚠️ Deploy returned failure. bins=${result.lower_bin}..${result.upper_bin}`,
          );
        }
      } catch (err) {
        deps.ctx.logger.warn("telegram-router", "deploy threw", {
          error: err instanceof Error ? err.message : String(err),
        });
        await deps.ctx.notifier.notify(
          "warn",
          `❌ Deploy failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    case "/status":
    case "/wallet": {
      const [wallet, snap] = await Promise.all([
        deps.ctx.chain.getWalletBalance(),
        cmd === "/status" ? deps.ctx.chain.getMyPositions() : Promise.resolve(null),
      ]);
      const lines = [
        `Wallet: ${wallet.sol} SOL (~$${wallet.sol_usd.toFixed(2)} @ $${wallet.sol_price.toFixed(2)}/SOL)`,
      ];
      if (snap) {
        lines.push(`Open positions: ${snap.total_positions}`);
      }
      await deps.ctx.notifier.notify("info", lines.join("\n"));
      return;
    }

    case "/positions": {
      const snap = await deps.ctx.chain.getMyPositions();
      if (snap.total_positions === 0) {
        await deps.ctx.notifier.notify("info", "No open positions.");
        return;
      }
      const lines = ["Open positions:"];
      for (const p of snap.positions) {
        const pnl = p.pnl_pct == null ? "?" : `${p.pnl_pct.toFixed(2)}%`;
        lines.push(
          `  ${p.pair} pos=${p.position.slice(0, 8)}… pnl=${pnl} in_range=${p.in_range}`,
        );
      }
      await deps.ctx.notifier.notify("info", lines.join("\n"));
      return;
    }

    case "/briefing": {
      const summary = await runBriefingCycle({ ctx: deps.ctx });
      deps.ctx.logger.info("telegram-router", "briefing pushed on demand", {
        opened: summary.counts.opened_24h,
      });
      return;
    }

    default: {
      // Free-form → GENERAL agent tick.
      const goal = trimmed;
      const [wallet, snap, activeStrategy, recentDecisions] = await Promise.all([
        deps.ctx.chain.getWalletBalance(),
        deps.ctx.chain.getMyPositions(),
        deps.ctx.repos.strategies.getActive(),
        deps.ctx.repos.decisions.recent(5),
      ]);
      const systemPrompt = buildSystemPrompt({
        role: "GENERAL",
        wallet,
        positions: snap,
        config: deps.ctx.config,
        activeStrategy,
        recentDecisions,
      });
      const result = await runAgentLoop(
        { llm: deps.llm, registry: deps.registry, ctx: deps.ctx },
        {
          role: "GENERAL",
          goal,
          systemPrompt,
          model: deps.model,
          maxSteps: 8,
          toolFilter: GENERAL_TOOLS,
          requireToolOnFirstStep: false,
        },
      );
      const text = result.text ?? "(no text response)";
      await deps.ctx.notifier.notify("info", text.slice(0, 3800));
      // Unused for now, retained for future logging hooks.
      void rest;
      return;
    }
  }
}
