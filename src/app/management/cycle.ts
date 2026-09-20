import type { AppContext } from "../tools/context.js";
import type { ToolRegistry } from "../tools/registry.js";
import { executeTool, type ToolError } from "../tools/execute.js";
import {
  getDeterministicCloseRule,
  getExitDecision,
  type ExitRegime,
} from "../../domain/rules/close-rules.js";
import type { OnChainPosition } from "../../domain/schemas/chain.js";
import type { KlineTimeframe, TechnicalsSummary } from "../../domain/schemas/kline.js";
import { computeTechnicals, formatTechnicalsLine } from "../../domain/format/technicals.js";
import type { SageExitAdvisor } from "../../ports/sage-exit-advisor.js";
import { partitionMirrorOwnership } from "../../domain/rules/follow-diff.js";

const EXIT_ADVISOR_PROMPT = [
  "You are Meridian's DLMM position EXIT advisor. Given ONE open position's live",
  "signals, decide whether to CLOSE it now or HOLD it. This position was flagged",
  "AMBIGUOUS by the deterministic engine: it is at/below the stop level but is neither",
  "clearly collapsing (already cut) nor clearly healthy (already held).",
  "",
  "Judgement guide:",
  "  - CLOSE if structure is breaking: price out of range to the DOWNSIDE, support",
  "    gone, both timeframes trending DOWN, volume/fees dead, or a long red-candle streak.",
  "  - HOLD if it is in-range and still earning fees, or oscillating with live volatility",
  "    that DLMM can farm — paper IL that is likely to mean-revert is not a reason to cut.",
  "",
  "Reply with EXACTLY one line: `CLOSE: <short reason>` or `HOLD: <short reason>`.",
  "No tool calls, no other text.",
].join("\n");

/** Compact single-position signal block for the exit advisor. */
function buildExitSignalBlock(plan: PositionPlan, technicals?: readonly TechnicalsSummary[]): string {
  const p = plan.position;
  const rangeStr =
    p.active_bin != null && p.lower_bin != null && p.upper_bin != null
      ? `active_bin=${p.active_bin} range=[${p.lower_bin},${p.upper_bin}] ${p.active_bin < p.lower_bin ? "(OOR-BELOW)" : p.active_bin > p.upper_bin ? "(OOR-ABOVE)" : "(in-range)"}`
      : `in_range=${p.in_range ?? "?"}`;
  const lines = [
    `POSITION ${p.pair ?? p.position.slice(0, 8)}`,
    `pnl=${p.pnl_pct?.toFixed(1) ?? "n/a"}%  fee_per_tvl_24h=${p.fee_per_tvl_24h?.toFixed(2) ?? "n/a"}  age=${p.age_minutes ?? "?"}m`,
    rangeStr,
    `deterministic_note: ${plan.reason}`,
  ];
  const techLines = (technicals ?? [])
    .map(formatTechnicalsLine)
    .filter((l): l is string => l != null);
  if (techLines.length) lines.push("technicals:", ...techLines.map((l) => `  ${l}`));
  return lines.join("\n");
}

/**
 * Resolve an AMBIGUOUS ESCALATE plan into CLOSE or STAY. Cooldown-gated per
 * position; consults Sage when armed, else applies the conditional deterministic
 * fallback (in-range → HOLD, OOR/deep → CLOSE). Never throws.
 */
async function resolveEscalation(
  plan: PositionPlan,
  deps: ManagementCycleDeps,
  technicals?: readonly TechnicalsSummary[],
): Promise<{ action: "CLOSE" | "STAY"; reason: string }> {
  const { ctx } = deps;
  const mgmt = ctx.config.management;
  const p = plan.position;
  const inRange =
    p.in_range === true ||
    (p.in_range == null &&
      p.active_bin != null &&
      p.lower_bin != null &&
      p.upper_bin != null &&
      p.active_bin >= p.lower_bin &&
      p.active_bin <= p.upper_bin);
  const fallback = (why: string): { action: "CLOSE" | "STAY"; reason: string } =>
    inRange
      ? { action: "STAY", reason: `ambiguous→fallback HOLD (in-range; ${why})` }
      : { action: "CLOSE", reason: `ambiguous→fallback CLOSE (OOR; ${why})` };

  const tracked = await ctx.repos.positions.get(p.position);
  const now = ctx.clock.now();
  const lastEsc = tracked?.last_sage_exit_escalation_at;
  if (lastEsc) {
    const mins = (now.getTime() - Date.parse(lastEsc)) / 60_000;
    if (Number.isFinite(mins) && mins < mgmt.sageExitCooldownMin) {
      return { action: "STAY", reason: `ambiguous — within Sage cooldown (${mins.toFixed(0)}<${mgmt.sageExitCooldownMin}m), holding` };
    }
  }

  if (!mgmt.sageExitEnabled || !deps.sageExit) {
    return fallback("Sage exit disabled");
  }

  try {
    const verdict = await deps.sageExit.advise({
      systemPrompt: EXIT_ADVISOR_PROMPT,
      goal: buildExitSignalBlock(plan, technicals),
      sessionKey: deps.sageSessionKey ?? "meridian-trading",
      timeoutMs: deps.sageTimeoutMs ?? 30_000,
    });
    if (tracked) {
      await ctx.repos.positions.upsert({ ...tracked, last_sage_exit_escalation_at: now.toISOString() });
    }
    ctx.logger.info("management", `sage exit verdict ${verdict.action} ${p.position.slice(0, 8)}…`, {
      reason: verdict.reason,
    });
    return verdict.action === "CLOSE"
      ? { action: "CLOSE", reason: `Sage: ${verdict.reason}` }
      : { action: "STAY", reason: `Sage: ${verdict.reason}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (tracked) {
      await ctx.repos.positions.upsert({ ...tracked, last_sage_exit_escalation_at: now.toISOString() });
    }
    ctx.logger.warn("management", `sage exit-advisor failed ${p.position.slice(0, 8)}… — ${msg}`);
    return fallback(`Sage unreachable: ${msg}`);
  }
}

export type PositionAction = "CLOSE" | "CLAIM" | "STAY" | "ESCALATE";

export interface PositionPlan {
  position: OnChainPosition;
  action: PositionAction;
  reason: string;
  /** Smart-exit regime that produced this plan (for shadow logging + escalation). */
  regime?: ExitRegime;
}

export interface ManagementCycleDeps {
  ctx: AppContext;
  registry: ToolRegistry;
  /** Optional Sage exit advisor for AMBIGUOUS escalation. Absent → conditional fallback only. */
  sageExit?: SageExitAdvisor;
  sageSessionKey?: string;
  sageTimeoutMs?: number;
}

const MGMT_TIMEFRAMES: readonly KlineTimeframe[] = ["15m", "1h"] as const;
const MGMT_KLINE_LIMIT = 100;
const MGMT_KLINE_TIMEOUT_MS = 3_500;

/**
 * Per-open-position OHLCV → technicals, mirroring screening's enrichTechnicals.
 * Fail-open: a rate-limit / missing history drops that timeframe's row but never
 * throws. Keyed by position address. Only called in the management path (10 min),
 * never the 30s poller.
 */
async function enrichPositionTechnicals(
  positions: readonly OnChainPosition[],
  ctx: AppContext,
): Promise<Map<string, TechnicalsSummary[]>> {
  const timeout = <T,>(p: Promise<T>): Promise<T | null> =>
    Promise.race([
      p,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), MGMT_KLINE_TIMEOUT_MS)),
    ]);
  const windowShort = ctx.config.screening.technicalsWindowShort;
  const windowMin = Math.max(3, Math.floor(ctx.config.screening.minTokenAgeHours ?? 3));
  const out = new Map<string, TechnicalsSummary[]>();
  await Promise.all(
    positions.map(async (p) => {
      const rows = await Promise.all(
        MGMT_TIMEFRAMES.map(async (tf) => {
          const candles = await timeout(
            ctx.market.kline.getKline(p.pool, tf, { limit: MGMT_KLINE_LIMIT }),
          ).catch(() => null);
          return computeTechnicals(candles ?? [], tf, { windowShort, windowMin });
        }),
      );
      out.set(p.position, rows);
    }),
  );
  return out;
}

export interface ExecutedAction {
  plan: PositionPlan;
  ok: boolean;
  error?: ToolError;
}

export type ManagementOutcome =
  | { kind: "no_positions" }
  | { kind: "all_stay"; positions: number }
  | { kind: "executed"; plans: PositionPlan[]; results: ExecutedAction[] };

/**
 * Pure — decide the action for a single position. Priority:
 *   1. Deterministic close rule (5 hard rules).
 *   2. Claim if unclaimed fees ≥ threshold.
 *   3. Else STAY.
 */
export function planForPosition(
  position: OnChainPosition,
  ctx: Pick<AppContext, "config">,
  technicals?: readonly TechnicalsSummary[],
): PositionPlan {
  const mgmt = ctx.config.management;
  const live = {
    position: position.position,
    pnl_pct: position.pnl_pct,
    pnl_pct_suspicious: position.pnl_pct_suspicious,
    total_value_usd: position.total_value_usd ?? null,
    in_range: position.in_range,
    active_bin: position.active_bin,
    upper_bin: position.upper_bin,
    lower_bin: position.lower_bin,
    minutes_out_of_range: position.minutes_out_of_range ?? 0,
    fee_per_tvl_24h: position.fee_per_tvl_24h ?? null,
    age_minutes: position.age_minutes ?? 0,
  };

  if (mgmt.smartExitEnabled) {
    // Take-profit / OOR-pump / low-yield still deterministic; the regime engine
    // owns the downside stop dimension (rule 1 suppressed).
    const nonStop = getDeterministicCloseRule(live, mgmt, {}, { skipStopLoss: true });
    if (nonStop) {
      return { position, action: "CLOSE", reason: nonStop.reason, regime: "OK" };
    }
    const ex = getExitDecision({ ...live, technicals }, mgmt);
    if (ex.action === "CLOSE") {
      return { position, action: "CLOSE", reason: ex.reason, regime: ex.regime };
    }
    if (ex.action === "ESCALATE") {
      return { position, action: "ESCALATE", reason: ex.reason, regime: ex.regime };
    }
    // HOLD → fall through to claim/stay, carrying the regime for the shadow log.
    if (position.unclaimed_fees_usd >= mgmt.minClaimAmount) {
      return {
        position,
        action: "CLAIM",
        reason: `unclaimed_fees_usd ${position.unclaimed_fees_usd.toFixed(2)} ≥ ${mgmt.minClaimAmount}`,
        regime: ex.regime,
      };
    }
    return { position, action: "STAY", reason: ex.reason, regime: ex.regime };
  }

  // Legacy path (smartExitEnabled=false): static rule-1 stop drives closes.
  // The regime is still classified (shadow) purely for the observability log.
  const shadow = getExitDecision({ ...live, technicals }, mgmt);
  const close = getDeterministicCloseRule(live, mgmt);
  if (close) {
    return { position, action: "CLOSE", reason: close.reason, regime: shadow.regime };
  }
  if (position.unclaimed_fees_usd >= mgmt.minClaimAmount) {
    return {
      position,
      action: "CLAIM",
      reason: `unclaimed_fees_usd ${position.unclaimed_fees_usd.toFixed(2)} ≥ ${mgmt.minClaimAmount}`,
      regime: shadow.regime,
    };
  }
  return { position, action: "STAY", reason: "all rules pass", regime: shadow.regime };
}

/**
 * Fully deterministic — no LLM. planForPosition picks the action; executeTool
 * runs it (with the full safety-gate + post-hook pipeline: notify cards, decision
 * log, auto-swap consolidation). LLM was previously used only to emit tool_calls,
 * adding latency, cost, and a once-per-session lock that capped closes to one
 * per cycle. Removing it fixes all three.
 *
 *   1. Fetch positions with `force: true` (fresh count).
 *   2. Reconcile any on-chain position missing from the tracking store.
 *   3. planForPosition per position.
 *   4. If every action is STAY → return `all_stay`.
 *   5. Else invoke each non-STAY action directly via executeTool, sequentially
 *      (safer than parallel — same wallet, same nonce space).
 */
export async function runManagementCycle(deps: ManagementCycleDeps): Promise<ManagementOutcome> {
  const { ctx, registry } = deps;

  const snap = await ctx.chain.getMyPositions({ force: true });

  // Reverse reconcile: any position tracked as OPEN in state.json but no longer
  // on-chain (closed via close_position, pnl-poller direct call, Meteora UI, etc.)
  // gets flipped to closed. Must run BEFORE the empty-snapshot early return, or
  // ghost-open records persist forever when the wallet is fully drained of
  // positions (dashboard summary reported 3 ghost open vs 0 on-chain, 2026-08-06).
  const nowIsoR = ctx.clock.now().toISOString();
  const onChainIds = new Set(snap.positions.map((p) => p.position));
  const tracked = await ctx.repos.positions.all();
  for (const t of tracked) {
    if (t.closed) continue;
    if (onChainIds.has(t.position)) continue;
    await ctx.repos.positions.upsert({
      ...t,
      closed: true,
      closed_at: nowIsoR,
      notes: [...(t.notes ?? []), "reconciled: no longer on-chain (external close or ghost record)"],
    });
    ctx.logger.info("management", `reconciled ghost-open position ${t.position.slice(0, 8)}… as closed`);
  }

  if (snap.total_positions === 0) {
    ctx.logger.info("management", "no positions — nothing to do");
    return { kind: "no_positions" };
  }

  for (const p of snap.positions) {
    if (await ctx.repos.positions.get(p.position)) continue;
    const nowIso = ctx.clock.now().toISOString();
    await ctx.repos.positions.upsert({
      position: p.position,
      pool: p.pool,
      pool_name: p.pair,
      strategy: p.strategy ?? ctx.config.strategy.strategy,
      bin_range: { lower_bin: p.lower_bin, upper_bin: p.upper_bin },
      amount_sol: p.amount_sol ?? 0,
      amount_x: 0,
      active_bin_at_deploy: p.active_bin,
      bin_step: p.bin_step ?? null,
      volatility: null,
      fee_tvl_ratio: null,
      initial_fee_tvl_24h: p.fee_per_tvl_24h ?? null,
      organic_score: null,
      initial_value_usd: p.total_value_usd ?? null,
      deployed_at: p.deployed_at ?? nowIso,
      out_of_range_since: null,
      last_claim_at: null,
      total_fees_claimed_usd: 0,
      rebalance_count: 0,
      closed: false,
      closed_at: null,
      notes: ["reconciled from chain (untracked on-chain position)"],
      peak_pnl_pct: 0,
      trailing_active: false,
    });
    ctx.logger.info("management", `reconciled untracked position ${p.position.slice(0, 8)} into state`);
  }

  // Update out_of_range_since on every tracked position based on the fresh
  // on-chain snapshot, then compute minutes_out_of_range so the deterministic
  // rule 3 (OOR) actually has a value to compare against. Without this, the
  // on-chain client never populates minutes_out_of_range → rule 3 sees 0 →
  // never fires. Result was OOR positions sitting open indefinitely
  // (2026-08-05: Doom-SOL held 24 bins past upper for hours, no close).
  const nowMs = ctx.clock.now().getTime();
  const oorEnrichedSnapshot = await Promise.all(
    snap.positions.map(async (p) => {
      const t = await ctx.repos.positions.get(p.position);
      if (!t || t.closed) return p;
      let oorSince = t.out_of_range_since;
      let mutated = false;
      if (p.in_range === false && !oorSince) {
        oorSince = ctx.clock.now().toISOString();
        mutated = true;
      } else if (p.in_range === true && oorSince) {
        oorSince = null;
        mutated = true;
      }
      if (mutated) {
        await ctx.repos.positions.upsert({ ...t, out_of_range_since: oorSince });
      }
      const minutesOOR =
        oorSince != null
          ? Math.max(0, Math.floor((nowMs - Date.parse(oorSince)) / 60_000))
          : 0;
      // Overlay the derived minutes_out_of_range onto the on-chain position so
      // planForPosition → close-rules rule 3 sees it. Age is also seeded from
      // tracked.deployed_at when the chain client left it null.
      const derivedAge =
        p.age_minutes ??
        (t.deployed_at
          ? Math.max(0, Math.floor((nowMs - Date.parse(t.deployed_at)) / 60_000))
          : null);
      return {
        ...p,
        minutes_out_of_range: minutesOOR,
        ...(derivedAge != null ? { age_minutes: derivedAge } : {}),
      };
    }),
  );

  // Fetch OHLCV → technicals per open position (10-min path only; fail-open).
  const techByPos = await enrichPositionTechnicals(oorEnrichedSnapshot, ctx);

  const plans = oorEnrichedSnapshot.map((p) =>
    planForPosition(p, ctx, techByPos.get(p.position)),
  );

  // Follow-the-wallet positions are exempt from every LOCAL exit rule when
  // `follow.exclusiveExit` is on: the followed wallet owns the exit, and the follow
  // cycle closes these the moment that wallet leaves the pool. Without this, two
  // authorities race the same position — our stop-loss could close a mirror at -15%
  // while the wallet being copied is still holding, which is precisely what
  // copy-trading is supposed to avoid.
  //
  // The exemption covers only mirrors that are still OWNED — whose source wallet is
  // enabled, present, and being polled under a live `follow.enabled`. An orphan (master
  // switch off, wallet disabled, wallet removed) has no one left to decide its exit, so
  // it goes back under local rules here. The follow cycle drains orphans by closing them
  // outright; this is what covers the window until its next tick, and what covers the
  // case where the follow watcher is not running at all.
  //
  // CLAIM is deliberately left alone: collecting fees does not end the position.
  // Optional-chained: a caller may hand us a config/context assembled before this
  // feature existed, and management must keep working rather than throw on a missing key.
  if (ctx.config.follow?.exclusiveExit && ctx.repos.follow) {
    const { owned } = partitionMirrorOwnership({
      followEnabled: ctx.config.follow.enabled,
      wallets: await ctx.repos.follow.listWallets(),
      openMirrors: await ctx.repos.follow.listOpenMirrored(),
    });
    const followHeld = new Set(owned.map((m) => m.position));
    if (followHeld.size > 0) {
      for (const plan of plans) {
        if (!followHeld.has(plan.position.position)) continue;
        if (plan.action !== "CLOSE" && plan.action !== "ESCALATE") continue;
        ctx.logger.info(
          "management",
          `follow position ${plan.position.position.slice(0, 8)}… exempt from ${plan.action} (${plan.reason}) — the followed wallet owns the exit`,
        );
        plan.action = "STAY";
        plan.reason = `follow: exit deferred to the source wallet (local rule was: ${plan.reason})`;
      }
    }
  }

  // Shadow observability: log the classified regime for EVERY position each tick,
  // whether or not smartExitEnabled acts on it. Lets the operator watch the engine
  // during the dark-launch period before arming.
  for (const plan of plans) {
    ctx.logger.info(
      "management",
      `regime ${plan.regime ?? "n/a"} ${plan.position.position.slice(0, 8)}… → ${plan.action} (pnl ${plan.position.pnl_pct?.toFixed(1) ?? "n/a"}%)`,
      { reason: plan.reason },
    );
  }

  // Resolve AMBIGUOUS escalations (smart mode only) into CLOSE or STAY before
  // execution. Cooldown-gated per position; Sage advises, we execute.
  for (const plan of plans) {
    if (plan.action !== "ESCALATE") continue;
    const resolved = await resolveEscalation(plan, deps, techByPos.get(plan.position.position));
    plan.action = resolved.action;
    plan.reason = resolved.reason;
  }

  const actionsList = plans.filter((p) => p.action === "CLOSE" || p.action === "CLAIM");
  if (actionsList.length === 0) {
    ctx.logger.info("management", `all ${plans.length} positions STAY`);
    return { kind: "all_stay", positions: plans.length };
  }

  const results: ExecutedAction[] = [];
  for (const plan of actionsList) {
    const invocation =
      plan.action === "CLOSE"
        ? {
            name: "close_position",
            args: { position_address: plan.position.position, reason: plan.reason },
          }
        : {
            name: "claim_fees",
            args: { position_address: plan.position.position },
          };

    // Scoped ctx so the close decision is logged with actor=MANAGER +
    // the deterministic plan's rationale (e.g. "stop-loss triggered:
    // pnl -20% <= -18%"), not the generic close template.
    const mgmtCtx = {
      ...ctx,
      deployMeta: { actor: "MANAGER" as const, rationale: plan.reason },
    };
    const r = await executeTool(registry, invocation, mgmtCtx);
    if (r.ok) {
      results.push({ plan, ok: true });
      ctx.logger.info(
        "management",
        `${plan.action} ${plan.position.position.slice(0, 8)}… ok (${plan.reason})`,
      );
    } else {
      results.push({ plan, ok: false, error: r.error });
      ctx.logger.warn(
        "management",
        `${plan.action} ${plan.position.position.slice(0, 8)}… failed: ${r.error.kind}`,
      );
    }
  }

  ctx.logger.info(
    "management",
    `executed ${results.filter((r) => r.ok).length}/${results.length} actions`,
  );
  return { kind: "executed", plans, results };
}
