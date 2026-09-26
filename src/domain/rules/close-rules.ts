import type { ManagementConfig } from "../schemas/config.js";
import type { LivePositionSnapshot, TrackedPosition } from "../schemas/position.js";
import type { TechnicalsSummary } from "../schemas/kline.js";

export type CloseRuleId = 1 | 2 | 3 | 4 | 5;

export interface CloseDecision {
  action: "CLOSE";
  rule: CloseRuleId;
  reason: "stop loss" | "take profit" | "pumped far above range" | "OOR" | "low yield";
}

export interface PnlSuspectContext {
  tracked?: Pick<TrackedPosition, "amount_sol"> | null;
}

const MIN_TOTAL_VALUE_USD_FOR_SUSPECT = 0.01;
const PNL_PCT_SUSPECT_FLOOR = -90;
const MIN_LOW_YIELD_AGE_MINUTES = 60;

/**
 * Minutes after deploy during which the smart-exit engine refuses to act on pnl.
 * Meteora datapi lags a fresh deposit: for the first seconds-to-minutes a brand-new
 * position can read pnl −100% (balance not indexed yet). Without this window the
 * poller's CATASTROPHIC fast-cut closed OTC-SOL and FLAME-SOL 3–5 s after they
 * opened (2026-09-22/23). Deliberately short and separate from
 * `stopLossGraceMinutes` (30 min, an IL-tolerance setting): this is a
 * data-quality window, not a risk-tolerance one, so the hard floor stays a
 * near-unconditional backstop.
 */
export const PNL_WARMUP_MINUTES = 5;

/** True while a position is young enough that its pnl may not be indexed yet.
 *  Unknown age → false (never suppress exits on missing data). */
export function isInPnlWarmup(ageMinutes: number | null | undefined): boolean {
  return ageMinutes != null && ageMinutes < PNL_WARMUP_MINUTES;
}

export function isPnlSuspect(
  position: Pick<LivePositionSnapshot, "pnl_pct" | "pnl_pct_suspicious" | "total_value_usd">,
  ctx: PnlSuspectContext = {},
): boolean {
  if (position.pnl_pct_suspicious) return true;
  if (position.pnl_pct == null) return false;
  if (position.pnl_pct > PNL_PCT_SUSPECT_FLOOR) return false;
  const trackedAmount = ctx.tracked?.amount_sol;
  const totalValueUsd = position.total_value_usd ?? 0;
  if (trackedAmount != null && trackedAmount > 0 && totalValueUsd > MIN_TOTAL_VALUE_USD_FOR_SUSPECT) {
    return true;
  }
  return false;
}

/**
 * Deterministic close decision — the 5 hard rules mirroring index.js:900.
 * Pure over `position` + `managementConfig` + `ctx`. Returns null when position should stay open.
 */
export interface CloseRuleOptions {
  /** When true, rule 1 (the static pnl stop) is NOT evaluated — the smart-exit
   *  regime engine owns the downside stop dimension instead. Rules 2/3/4 still fire. */
  skipStopLoss?: boolean;
}

export function getDeterministicCloseRule(
  position: LivePositionSnapshot,
  managementConfig: ManagementConfig,
  ctx: PnlSuspectContext = {},
  opts: CloseRuleOptions = {},
): CloseDecision | null {
  const pnlSuspect = isPnlSuspect(position, ctx);

  // Rule 1 (stop_loss) is skipped for a grace window after deploy. Single-side
  // SOL entries land with active_bin = upper_bin, so any pump immediately puts
  // the position OOR — and the resulting IL routinely crosses stopLossPct in
  // the first few minutes before any fees can accumulate. Without a grace
  // window, fresh positions on volatile memes auto-close as pure IL losses
  // (TikTok-SOL, 2026-08-04 was −24.85% inside 1h). During the grace window
  // rule 3 (OOR wait) still fires normally, so a runaway keeps closing on
  // schedule; only the pnl-threshold rule waits.
  const graceMin = managementConfig.stopLossGraceMinutes;
  const withinGrace = graceMin > 0 && (position.age_minutes ?? 0) < graceMin;
  if (
    !opts.skipStopLoss &&
    !pnlSuspect &&
    !withinGrace &&
    position.pnl_pct != null &&
    position.pnl_pct <= managementConfig.stopLossPct
  ) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }

  if (
    !pnlSuspect &&
    position.pnl_pct != null &&
    position.pnl_pct >= managementConfig.takeProfitPct
  ) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }

  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 3, reason: "OOR" };
  }

  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= MIN_LOW_YIELD_AGE_MINUTES
  ) {
    return { action: "CLOSE", rule: 4, reason: "low yield" };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart-exit regime engine
// (deploy/SPEC-2026-08-29-smart-exit-regime-engine.md)
//
// Replaces the static rule-1 pnl stop with a regime classifier. PURE — no I/O.
// Owns ONLY the downside/stop dimension; take-profit (rule 2), OOR-pump (rule 3),
// and low-yield (rule 4) are still evaluated by getDeterministicCloseRule with
// skipStopLoss=true. This function decides: cut now, hold, or escalate to Sage.
// ─────────────────────────────────────────────────────────────────────────────

export type ExitRegime = "OK" | "CATASTROPHIC" | "DYING" | "HEALTHY" | "AMBIGUOUS";
export type ExitAction = "CLOSE" | "HOLD" | "ESCALATE";

export interface ExitSignals {
  pnl_pct: number | null;
  pnl_pct_suspicious?: boolean;
  total_value_usd?: number | null;
  in_range?: boolean | null;
  active_bin?: number | null;
  lower_bin?: number | null;
  upper_bin?: number | null;
  minutes_out_of_range?: number | null;
  fee_per_tvl_24h?: number | null;
  age_minutes?: number | null;
  /** Per-timeframe technicals (from OHLCV). Empty/omitted on the poller path. */
  technicals?: readonly TechnicalsSummary[] | undefined;
}

export interface ExitDecision {
  action: ExitAction;
  regime: ExitRegime;
  reason: string;
}

const near = <T,>(rows: readonly TechnicalsSummary[] | undefined, tf: string): TechnicalsSummary | undefined =>
  rows?.find((r) => r.timeframe === tf);

/**
 * Classify a position's downside regime and pick an action. Priority:
 *   1. suspect/unpriceable pnl → defer (HOLD; range rules handle it)
 *   2. CATASTROPHIC (pnl ≤ exitHardFloorPct) → CLOSE
 *   3. DYING (structural collapse) → CLOSE early, at ANY pnl:
 *        OOR-below AND (support broken OR both-TF DOWN OR dead vol),  OR
 *        N trailing red candles AND near-zero fee velocity
 *   4. not yet in loss-concern territory (pnl > stopLossPct) → HOLD (regime OK)
 *   5. HEALTHY (in-range + strong fees + not both-TF DOWN) → HOLD past the stop
 *   6. else AMBIGUOUS → ESCALATE (Sage decides; caller applies fallback)
 *
 * `stopLossPct` is reused as the attention threshold: above it (and not DYING),
 * there's no stop decision to make. DYING is checked FIRST so a collapsing
 * position is cut before it ever reaches the static stop level.
 */
export function getExitDecision(
  sig: ExitSignals,
  cfg: ManagementConfig,
  ctx: PnlSuspectContext = {},
): ExitDecision {
  const suspect = isPnlSuspect(
    { pnl_pct: sig.pnl_pct, pnl_pct_suspicious: sig.pnl_pct_suspicious ?? false, total_value_usd: sig.total_value_usd ?? null },
    ctx,
  );
  if (suspect || sig.pnl_pct == null) {
    return { action: "HOLD", regime: "AMBIGUOUS", reason: "pnl unpriceable — deferring to range rules" };
  }
  if (isInPnlWarmup(sig.age_minutes)) {
    return {
      action: "HOLD",
      regime: "OK",
      reason: `pnl warm-up: age ${sig.age_minutes}m < ${PNL_WARMUP_MINUTES}m, datapi may not have indexed the deposit`,
    };
  }
  const pnl = sig.pnl_pct;

  // 2. CATASTROPHIC — unconditional backstop.
  if (pnl <= cfg.exitHardFloorPct) {
    return {
      action: "CLOSE",
      regime: "CATASTROPHIC",
      reason: `catastrophic: pnl ${pnl.toFixed(1)}% ≤ floor ${cfg.exitHardFloorPct}%`,
    };
  }

  // 3. DYING — structural collapse; cut early regardless of pnl level.
  const t1h = near(sig.technicals, "1h");
  const t15 = near(sig.technicals, "15m");
  const oorBelow =
    sig.active_bin != null && sig.lower_bin != null && sig.active_bin < sig.lower_bin;
  const presentTrends = [t15?.trend, t1h?.trend].filter((t): t is "UP" | "DOWN" | "FLAT" => t != null);
  const bothTrendDown = presentTrends.length > 0 && presentTrends.every((t) => t === "DOWN");
  // support broken = no swing-low below current close on 1h (price fell through the floor).
  const supportBroken = t1h != null && t1h.nearest_support == null && t1h.candles > 0;
  const deadVol = t1h?.atr_pct != null && t1h.atr_pct < cfg.dyingAtrCollapsePct;
  const redStreak = Math.max(
    t15?.consecutive_red_count ?? 0,
    t1h?.consecutive_red_count ?? 0,
  );
  const feeNearZero =
    sig.fee_per_tvl_24h != null && sig.fee_per_tvl_24h < cfg.minFeePerTvl24h;

  if (oorBelow && (supportBroken || bothTrendDown || deadVol)) {
    const why = supportBroken ? "support broken" : bothTrendDown ? "both-TF DOWN" : "dead vol";
    return {
      action: "CLOSE",
      regime: "DYING",
      reason: `dying: OOR-below + ${why} (pnl ${pnl.toFixed(1)}%)`,
    };
  }
  if (redStreak >= cfg.dyingConsecutiveRed && feeNearZero) {
    return {
      action: "CLOSE",
      regime: "DYING",
      reason: `dying: ${redStreak} red candles + fee velocity ${(sig.fee_per_tvl_24h ?? 0).toFixed(1)} < ${cfg.minFeePerTvl24h} (pnl ${pnl.toFixed(1)}%)`,
    };
  }

  // 4. Not in loss-concern territory yet → nothing to decide.
  if (pnl > cfg.stopLossPct) {
    return { action: "HOLD", regime: "OK", reason: `pnl ${pnl.toFixed(1)}% above stop ${cfg.stopLossPct}%` };
  }

  // 5. HEALTHY — in-range, earning real fees, not trending down → let fees work.
  const inRange =
    sig.in_range === true ||
    (sig.in_range == null &&
      sig.active_bin != null &&
      sig.lower_bin != null &&
      sig.upper_bin != null &&
      sig.active_bin >= sig.lower_bin &&
      sig.active_bin <= sig.upper_bin);
  const feeHealthy =
    sig.fee_per_tvl_24h != null && sig.fee_per_tvl_24h >= cfg.healthyFeeVelocityMin;
  if (inRange && feeHealthy && !bothTrendDown) {
    return {
      action: "HOLD",
      regime: "HEALTHY",
      reason: `healthy: in-range, fee velocity ${sig.fee_per_tvl_24h!.toFixed(1)} ≥ ${cfg.healthyFeeVelocityMin}, holding past stop (pnl ${pnl.toFixed(1)}%)`,
    };
  }

  // 6. AMBIGUOUS — mixed signals; escalate to Sage (caller applies fallback).
  return {
    action: "ESCALATE",
    regime: "AMBIGUOUS",
    reason: `ambiguous: pnl ${pnl.toFixed(1)}% ≤ stop ${cfg.stopLossPct}% but not clearly dying or healthy`,
  };
}

/**
 * Poller (30s, on-chain only, NO OHLCV) fast-cut. Cheap subset of the regime engine:
 *   - CATASTROPHIC floor, OR
 *   - OOR-below AND pnl ≤ exitOorProxyPct (already this far below range — not
 *     recovering before the next 10-min management tick).
 * Returns a close reason, or null to leave it to the management cycle.
 * Nothing fires inside the pnl warm-up window (see PNL_WARMUP_MINUTES).
 */
export function getPollerFastCut(sig: ExitSignals, cfg: ManagementConfig, ctx: PnlSuspectContext = {}): string | null {
  const suspect = isPnlSuspect(
    { pnl_pct: sig.pnl_pct, pnl_pct_suspicious: sig.pnl_pct_suspicious ?? false, total_value_usd: sig.total_value_usd ?? null },
    ctx,
  );
  if (suspect || sig.pnl_pct == null) return null;
  if (isInPnlWarmup(sig.age_minutes)) return null;
  if (sig.pnl_pct <= cfg.exitHardFloorPct) {
    return `catastrophic: pnl ${sig.pnl_pct.toFixed(1)}% ≤ floor ${cfg.exitHardFloorPct}%`;
  }
  const oorBelow =
    sig.active_bin != null && sig.lower_bin != null && sig.active_bin < sig.lower_bin;
  if (oorBelow && sig.pnl_pct <= cfg.exitOorProxyPct) {
    return `dying (poller): OOR-below + pnl ${sig.pnl_pct.toFixed(1)}% ≤ ${cfg.exitOorProxyPct}%`;
  }
  return null;
}
