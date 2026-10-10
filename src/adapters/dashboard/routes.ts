// Bridge router: /health, /state/positions, /events, /state/summary, /state/file/:name,
// POST /tool, POST /chat. Thin glue over the DI context — the daemon core is untouched.
// Ported from dashboard/bridge/routes.js; the JS module singletons (executeTool, config,
// agentLoop, getMyPositions, getStateSummary, getWalletBalances, log) become the injected
// registry / ctx / llm. Response shapes preserved snake_case per the web contract.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatMessage } from "../../ports/llm-client.js";
import { executeTool, formatToolError } from "../../app/tools/execute.js";
import { runAgentLoop } from "../../app/agent/loop.js";
import { buildSystemPrompt } from "../../domain/prompt/builder.js";
import type { BridgeDeps } from "./server.js";
import type { SseHub } from "./sse.js";
import { buildStateSummary } from "./state-summary.js";
import { isAllowedTool, isWriteTool, resolveFile, CHAT_READ_TOOLS } from "./allowlist.js";
import { acquire, release } from "./inflight.js";
import { bridgeIdempotency } from "./idempotency.js";
import { redactSecrets } from "./redact.js";
import { adaptArgs, adaptResult } from "./tool-adapters.js";
import { assembleWalletBalance } from "./wallet-balance.js";

export type BridgeRouteDeps = BridgeDeps & { sse: SseHub };

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

// Strip model <think> blocks before surfacing to the UI (mirrors index.js stripThink).
const stripThink = (t = ""): string => String(t).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
// Write one SSE frame; swallow errors if the socket already closed.
const sseFrame = (res: ServerResponse, event: string, data: unknown): void => {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* closed */
  }
};

// rate-limit ?force=1 on positions: at most 1× / 10s (F5)
let _lastForce = 0;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw); // throw → caller → 400
}

/** Map the tool payload to the web's { ok, result } contract (mirrors JS bridge F6). */
function toolOk(value: unknown): boolean {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return v.success !== false && !v.error && !v.blocked;
  }
  return true;
}

export async function handleRequest(
  deps: BridgeRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  startedAt: number,
): Promise<void> {
  const { ctx, registry, llm, model, stateDir } = deps;
  const log = ctx.logger;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const p = url.pathname;

  // ── GET /health ──────────────────────────────────────────────
  if (req.method === "GET" && p === "/health") {
    return json(res, 200, {
      ok: true,
      uptime_sec: Math.round((Date.now() - startedAt) / 1000),
      daemon: "running",
      bridge_version: "1",
    });
  }

  // ── GET /state/positions[?force=1] ───────────────────────────
  if (req.method === "GET" && p === "/state/positions") {
    let force = url.searchParams.get("force") === "1";
    if (force && Date.now() - _lastForce < 10_000) force = false; // throttle
    if (force) _lastForce = Date.now();
    const rRaw = await ctx.chain
      .getMyPositions({ force })
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));

    // Enrich each on-chain position with tracked-side context (strategy,
    // deployed_at, entry_mcap, holders_at_entry, initial_value_usd,
    // volatility, fee_tvl_ratio, organic_score, bin_step,
    // active_bin_at_deploy, smart_wallets_present, pool_name) so the
    // Positions UI can render the expanded detail row without a second fetch.
    if (rRaw && typeof rRaw === "object" && "positions" in rRaw && Array.isArray(rRaw.positions)) {
      const merged = await Promise.all(
        rRaw.positions.map(async (op) => {
          if (!op || typeof op !== "object" || !("position" in op) || typeof op.position !== "string") return op;
          try {
            // Live pool lookup first (bin_step / mcap / holders / organic).
            // Runs regardless of tracked state — pool detail is cached ~1min so
            // the extra call is cheap, and we need bin_step whether or not the
            // position is in state.json.
            let currentMcap: number | null = null;
            let livePoolBinStep: number | null = null;
            let liveHolders: number | null = null;
            let liveOrganic: number | null = null;
            const poolAddr = (op as { pool?: string | null }).pool ?? null;
            if (poolAddr) {
              try {
                const poolDetail = await ctx.market.pools.getPoolDetail(poolAddr);
                if (poolDetail) {
                  currentMcap = poolDetail.mcap ?? null;
                  livePoolBinStep = poolDetail.bin_step ?? null;
                  liveHolders = poolDetail.holders ?? null;
                  liveOrganic = poolDetail.organic_score ?? null;
                }
              } catch {
                // non-fatal
              }
            }
            if (currentMcap == null) {
              const baseMint = (op as { base_mint?: string | null }).base_mint ?? null;
              if (baseMint) {
                try {
                  const info = await ctx.market.tokenInfo.getInfo(baseMint);
                  currentMcap = info.mcap ?? null;
                } catch {
                  // non-fatal
                }
              }
            }

            // Inline reconcile: if the position isn't in state.json (deployed
            // pre-hook, external UI, or before management cycle ticked), upsert
            // a minimal tracked record right now so the dashboard stops showing
            // "-" for tracked-side fields between deploys and the next
            // management tick. Mirrors the forward-reconcile in
            // src/app/management/cycle.ts:114 — kept in sync intentionally.
            let tracked = await ctx.repos.positions.get(op.position);
            if (!tracked) {
              const nowIso = ctx.clock.now().toISOString();
              const opAny = op as {
                pool?: string;
                pair?: string | null;
                lower_bin?: number;
                upper_bin?: number;
                active_bin?: number;
                total_value_usd?: number | null;
                fee_per_tvl_24h?: number | null;
                deposit_sol?: number | null;
                deposit_usd?: number | null;
              };
              // Prefer Meteora datapi's cumulative deposit for `amount_sol` +
              // `initial_value_usd` — recovers the true entry values for
              // externally-opened / pre-hook positions. Falls back to current
              // total (wrong number, but at least present) when datapi is cold.
              const depositSol = opAny.deposit_sol ?? null;
              const depositUsd = opAny.deposit_usd ?? null;
              try {
                await ctx.repos.positions.upsert({
                  position: op.position,
                  pool: opAny.pool ?? poolAddr ?? "",
                  pool_name: opAny.pair ?? null,
                  strategy: ctx.config.strategy.strategy,
                  bin_range: {
                    lower_bin: opAny.lower_bin ?? 0,
                    upper_bin: opAny.upper_bin ?? 0,
                  },
                  amount_sol: depositSol ?? 0,
                  amount_x: 0,
                  active_bin_at_deploy: opAny.active_bin ?? null,
                  bin_step: livePoolBinStep,
                  volatility: null,
                  fee_tvl_ratio: null,
                  initial_fee_tvl_24h: opAny.fee_per_tvl_24h ?? null,
                  organic_score: liveOrganic,
                  initial_value_usd: depositUsd ?? opAny.total_value_usd ?? null,
                  entry_mcap: currentMcap,
                  holders_at_entry: liveHolders,
                  smart_wallets_present: null,
                  entry_technicals: null,
                  deployed_at: nowIso,
                  out_of_range_since: null,
                  last_claim_at: null,
                  total_fees_claimed_usd: 0,
                  rebalance_count: 0,
                  closed: false,
                  closed_at: null,
                  notes: ["reconciled from dashboard (untracked on-chain position)"],
                  peak_pnl_pct: 0,
                  trailing_active: false,
                });
                tracked = await ctx.repos.positions.get(op.position);
              } catch {
                // non-fatal — fall through to the live-only enrichment
              }
            }
            // Mark records that came from reconcile (no deploy-hook context ever
            // captured) so the UI can label them "external" instead of rendering
            // "-" for fields that can't be recovered from chain (volatility,
            // fee_tvl_ratio, smart_wallets_present, entry_technicals).
            const isReconciled = !!tracked?.notes?.some((n) => n.startsWith("reconciled"));

            const nowMs = ctx.clock.now().getTime();
            const deployedMs = tracked ? Date.parse(tracked.deployed_at) : NaN;
            const ageMinutes = Number.isFinite(deployedMs)
              ? Math.max(0, Math.round((nowMs - deployedMs) / 60_000))
              : (op as { age_minutes?: number | null }).age_minutes ?? null;
            // Derive pnl_usd (price only, fees EXCLUDED — same as the History
            // record) so the UI has a dollar figure. Entry = Meteora's recorded
            // deposit, else our tracked deploy-time value; with neither, back it
            // out algebraically:
            //   entry = total / (1 + pnl_pct/100)
            //   pnl_usd = total - entry = total × pnl_pct / (100 + pnl_pct)
            // The web UI adds claimed + unclaimed fees on top for the net figure
            // Meteora shows (dashboard/web/lib/position-pnl.ts).
            const totalUsd = (op as { total_value_usd?: number | null }).total_value_usd ?? null;
            const pnlPct = (op as { pnl_pct?: number | null }).pnl_pct ?? null;
            const entryUsd =
              (op as { deposit_usd?: number | null }).deposit_usd ?? tracked?.initial_value_usd ?? null;
            let derivedPnlUsd: number | null = null;
            if (totalUsd != null && entryUsd != null) {
              derivedPnlUsd = Math.round((totalUsd - entryUsd) * 100) / 100;
            } else if (totalUsd != null && pnlPct != null && 100 + pnlPct !== 0) {
              derivedPnlUsd = Math.round(((totalUsd * pnlPct) / (100 + pnlPct)) * 100) / 100;
            }

            return {
              ...op,
              ...(derivedPnlUsd != null ? { pnl_usd: derivedPnlUsd } : {}),
              pool_name: tracked?.pool_name ?? (op as { pool_name?: string | null }).pool_name ?? (op as { pair?: string | null }).pair ?? null,
              strategy: tracked?.strategy ?? (op as { strategy?: string }).strategy,
              deployed_at: tracked?.deployed_at ?? null,
              age_minutes: ageMinutes,
              amount_sol_initial: tracked?.amount_sol ?? null,
              initial_value_usd: tracked?.initial_value_usd ?? null,
              entry_mcap: tracked?.entry_mcap ?? null,
              current_mcap: currentMcap,
              holders_at_entry: tracked?.holders_at_entry ?? liveHolders,
              smart_wallets_present: tracked?.smart_wallets_present ?? null,
              bin_step: tracked?.bin_step ?? livePoolBinStep,
              volatility: tracked?.volatility ?? null,
              fee_tvl_ratio: tracked?.fee_tvl_ratio ?? null,
              organic_score: tracked?.organic_score ?? liveOrganic,
              active_bin_at_deploy: tracked?.active_bin_at_deploy ?? null,
              peak_pnl_pct: tracked?.peak_pnl_pct ?? null,
              source: isReconciled ? "external" : "deploy",
            };
          } catch {
            return op;
          }
        }),
      );
      return json(res, 200, { ...rRaw, positions: merged });
    }
    return json(res, 200, rRaw);
  }

  // ── GET /events (SSE; piggybacks poller cache, no new RPC — §8.7/#8) ──
  if (req.method === "GET" && p === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const hb = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }, 30_000);
    deps.sse.subscribe(res);
    req.on("close", () => {
      clearInterval(hb);
      deps.sse.unsubscribe(res);
    });
    return; // keep the connection open — do NOT json()/end
  }

  // ── GET /logs?limit=&level= (in-memory daemon log ring) ──────
  if (req.method === "GET" && p === "/logs") {
    const limRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limRaw) ? Math.min(Math.max(limRaw, 1), 1000) : 200;
    const lvl = url.searchParams.get("level");
    const minLevel =
      lvl === "debug" || lvl === "info" || lvl === "warn" || lvl === "error" ? lvl : "debug";
    const lines = deps.logStore ? deps.logStore.get({ limit, minLevel }) : [];
    return json(res, 200, { lines });
  }

  // ── GET /state/summary ───────────────────────────────────────
  if (req.method === "GET" && p === "/state/summary") {
    const [summary, balance] = await Promise.all([
      buildStateSummary(ctx.repos.positions, ctx.clock).catch(() => null),
      assembleWalletBalance(ctx.chain).catch(() => null),
    ]);
    return json(res, 200, { summary, balance });
  }

  // ── GET /state/file/:name (whitelist + redaction) ────────────
  if (req.method === "GET" && p.startsWith("/state/file/")) {
    const name = p.slice("/state/file/".length);
    const file = resolveFile(name); // null unless exact whitelist key
    if (!file) return json(res, 400, { error: "invalid file name" });
    try {
      // user-config lives at ctx.configPath (daemon cwd = /app), NOT stateDir
      // (/opt/data). In production the two diverge and only ctx.configPath is the
      // source of truth — reading from stateDir yielded an empty stub file.
      const fpath = name === "user-config" ? ctx.configPath : path.join(stateDir, file);
      const data = JSON.parse(await readFile(fpath, "utf8")) as unknown;
      return json(res, 200, name === "user-config" ? redactSecrets(data) : data);
    } catch {
      return json(res, 404, { error: "not found" });
    }
  }

  // ── POST /tool ───────────────────────────────────────────────
  if (req.method === "POST" && p === "/tool") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const { name, args = {}, confirm = false, cycle_id, rationale } =
      (body as {
        name?: string;
        args?: Record<string, unknown>;
        confirm?: boolean;
        cycle_id?: string;
        rationale?: string;
      }) || {};
    if (!name) return json(res, 400, { error: "missing name" });
    if (!isAllowedTool(name)) return json(res, 403, { error: `tool not allowed: ${name}` });

    const write = isWriteTool(name);
    if (write && confirm !== true) return json(res, 403, { error: "confirm required" });
    // Hard gate: config edits are human-only. A cycle_id is only ever attached
    // by autonomous screening delegation → its presence means "this call did not
    // come from a human chat". No prompt can bypass this — the check is here,
    // not in Sage's system prompt.
    if (name === "update_config" && typeof cycle_id === "string" && cycle_id.length > 0) {
      return json(res, 403, {
        error: "update_config is human-gated; not permitted inside a delegation cycle",
        cycle_id,
      });
    }
    // Idempotency: a write carrying a cycle_id that already committed (e.g. the
    // screening delegation succeeded, then its fallback retried the same cycle) is a
    // duplicate — reject before acquiring the lock or executing. See idempotency.ts.
    const cycleId = typeof cycle_id === "string" && cycle_id.length > 0 ? cycle_id : undefined;
    if (write && cycleId && bridgeIdempotency.seen(cycleId))
      return json(res, 409, { error: "duplicate cycle_id", cycle_id: cycleId });
    if (write && !acquire(name)) return json(res, 409, { error: "in-flight", tool: name });

    try {
      if (write) log.info("dashboard", `tool=${name}`); // one line only; executeTool audits internally
      const adaptedArgs = adaptArgs(name, args ?? {});
      // Attribution for deploy/close post-hooks. cycle_id present → autonomous
      // delegation cycle (Sage). Absent → user-triggered chat/dashboard action.
      // Without this the post-hook falls back to SCREENER, which is wrong for
      // both bridge paths and made every deploy look daemon-authored (2026-08-26).
      const callCtx =
        name === "deploy_position" || name === "close_position"
          ? {
              ...ctx,
              deployMeta: {
                actor: (cycleId ? "SAGE" : "GENERAL") as "SAGE" | "GENERAL",
                ...(typeof rationale === "string" && rationale.trim()
                  ? { rationale: rationale.trim().slice(0, 2000) }
                  : {}),
              },
            }
          : ctx;
      // Loud warning when a Sage cycle deploys/closes without a rationale —
      // the log entry will fall back to the generic template, which is
      // exactly the auditability gap that hid the Sue deploy on 2026-08-26.
      // Prompts require rationale, but a rollout / model drift could silently
      // drop it; log so ops can spot it before the next incident.
      if (
        (name === "deploy_position" || name === "close_position") &&
        cycleId &&
        (typeof rationale !== "string" || !rationale.trim())
      ) {
        log.warn(
          "dashboard",
          `${name} from Sage (cycle=${cycleId}) missing rationale — decision log will show generic template`,
        );
      }
      const outcome = await executeTool(registry, { name, args: adaptedArgs }, callCtx);
      if (outcome.ok) {
        // Commit the idempotency key only on success, so a failed write stays retryable.
        if (write && cycleId) bridgeIdempotency.commit(cycleId);
        // get_wallet_balance needs async token enrichment (tokens[] + total_usd) that a
        // pure result adapter can't do — assemble the web shape from the chain client.
        const value =
          name === "get_wallet_balance"
            ? await assembleWalletBalance(ctx.chain).catch(() => outcome.value)
            : adaptResult(name, outcome.value);
        return json(res, 200, { ok: toolOk(value), result: value });
      }
      const blocked = outcome.error.kind === "safety_blocked";
      return json(res, 200, {
        ok: false,
        result: { error: formatToolError(outcome.error), blocked },
      });
    } finally {
      if (write) release(name);
    }
  }

  // ── POST /chat (streaming; read-only agentLoop GENERAL — M5 Fase A) ──
  // Read-only by construction: runAgentLoop only sees CHAT_READ_TOOLS, so the LLM cannot
  // pick a write tool. Writes stay on the confirm-gated /tool path (M2).
  if (req.method === "POST" && p === "/chat") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const b = body as { message?: unknown; history?: unknown };
    const message = typeof b?.message === "string" ? b.message.trim() : "";
    if (!message) return json(res, 400, { error: "missing message" });
    const history: ChatMessage[] = Array.isArray(b?.history)
      ? (b.history as unknown[])
          .filter(
            (m): m is { role: "user" | "assistant"; content: string } =>
              !!m &&
              typeof m === "object" &&
              ((m as { role?: unknown }).role === "user" ||
                (m as { role?: unknown }).role === "assistant") &&
              typeof (m as { content?: unknown }).content === "string",
          )
          .slice(-10)
          .map((m) => ({ role: m.role, content: m.content }))
      : [];

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    let closed = false;
    const hb = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }, 20_000);
    req.on("close", () => {
      closed = true;
      clearInterval(hb);
    });

    try {
      log.info("dashboard", "chat"); // one line only; executeTool inside the loop does the audit
      const [wallet, snap, activeStrategy, recentDecisions] = await Promise.all([
        ctx.chain.getWalletBalance(),
        ctx.chain.getMyPositions(),
        ctx.repos.strategies.getActive(),
        ctx.repos.decisions.recent(5),
      ]);
      const systemPrompt = buildSystemPrompt({
        role: "GENERAL",
        wallet,
        positions: snap,
        config: ctx.config,
        activeStrategy,
        recentDecisions,
      });
      const result = await runAgentLoop(
        { llm, registry, ctx },
        {
          role: "GENERAL",
          goal: message,
          systemPrompt,
          model,
          maxSteps: ctx.config.llm.maxSteps,
          history,
          toolFilter: CHAT_READ_TOOLS, // read-only surface (Fase A)
          onToolStart: (name) => {
            if (!closed) sseFrame(res, "tool", { phase: "start", name });
          },
          onToolFinish: (name, ok) => {
            if (!closed) sseFrame(res, "tool", { phase: "finish", name, success: ok });
          },
        },
      );
      sseFrame(res, "done", { content: stripThink(result.text) });
    } catch (e) {
      sseFrame(res, "error", { message: e instanceof Error ? e.message : "chat failed" });
    } finally {
      clearInterval(hb);
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    return; // stream ended — do NOT json()/end again
  }

  return json(res, 404, { error: "not found" });
}
