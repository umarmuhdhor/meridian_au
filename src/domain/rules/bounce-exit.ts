import type { ManagementConfig } from "../schemas/config.js";
import type { KlineCandle } from "../schemas/kline.js";
import type { TrackedPosition } from "../schemas/position.js";
import { isPnlSuspect, type ExitRegime } from "./close-rules.js";

/**
 * Bounce-exit (2026-10-10). A smart-exit deep-loss trigger — the CATASTROPHIC floor, or
 * DYING once price has fallen out of range BELOW — used to sell immediately. By then
 * the single-side SOL range has been bought all the way down, so the sale lands on the
 * capitulation low. Live audit of the 12 such screener cuts (21 Sep–10 Oct): price
 * rebounded ≥10–15% within 6h in 9–12 of them, and every take/stop/timeout combination
 * replayed beat selling at once (+0.12..+0.39 SOL on 0.3-SOL positions).
 *
 * With `bounceExitEnabled` the trigger ARMS a watch instead of closing. The position —
 * by then mostly or entirely token — stays open and closes on whichever comes first:
 *   take    — value recovered `bounceTakePct`% from its value at the trigger
 *   stop    — value fell a FURTHER `bounceStopPct`% (replaces the catastrophic floor)
 *   timeout — `bounceTimeoutMin` elapsed
 * "Value" is 1 + pnl_pct/100: the position's own worth, which is right whether the
 * trigger fired below the range (all token, value tracks price) or inside it.
 */

export type BounceWatch = NonNullable<TrackedPosition["bounce_watch"]>;
export type BounceOutcome = "take" | "stop" | "timeout";
export type BounceConfig = Pick<ManagementConfig, "bounceTakePct" | "bounceStopPct" | "bounceTimeoutMin">;

export const BOUNCE_REASON_PREFIX = "bounce-exit";
export const BOUNCE_SHADOW_METHOD = "bounce-5m-v1";
const CANDLE_SEC = 300;
/** A trigger price older than this (no trade in the pool) is not a usable anchor. */
const MAX_ANCHOR_GAP_SEC = 1800;

export type BounceVerdict =
  | { action: "CLOSE"; outcome: BounceOutcome; reason: string }
  | { action: "HOLD"; reason: string };

/**
 * Does this smart-exit close qualify for a bounce watch? Only the two deep-loss
 * triggers do — a take-profit, OOR-above or low-yield close is never deferred, and
 * neither is a red-streak DYING that is still inside the range.
 */
export function isBounceTrigger(
  regime: ExitRegime | undefined,
  pos: { active_bin?: number | null; lower_bin?: number | null },
): boolean {
  if (regime === "CATASTROPHIC") return true;
  return regime === "DYING" && pos.active_bin != null && pos.lower_bin != null && pos.active_bin < pos.lower_bin;
}

/** A recorded close_reason that came from a deep-loss trigger sold at once (shadow candidates). */
export function isBounceEligibleCloseReason(reason: string | null | undefined): boolean {
  if (!reason || reason.includes(BOUNCE_REASON_PREFIX)) return false;
  return /catastrophic:|OOR-below/i.test(reason);
}

export function armBounceWatch(triggerPnlPct: number, triggerReason: string, now: Date): BounceWatch {
  return { started_at: now.toISOString(), trigger_pnl_pct: triggerPnlPct, trigger_reason: triggerReason };
}

/** Pure — resolve an armed watch against the live pnl. An unreadable pnl can only time out. */
export function evaluateBounceWatch(
  watch: BounceWatch,
  sig: { pnl_pct: number | null; pnl_pct_suspicious?: boolean | undefined; total_value_usd?: number | null | undefined },
  now: Date,
  cfg: BounceConfig,
): BounceVerdict {
  const startedMs = Date.parse(watch.started_at);
  const watchedMin = Number.isFinite(startedMs) ? Math.max(0, (now.getTime() - startedMs) / 60_000) : Infinity;
  const tail = `trigger pnl ${watch.trigger_pnl_pct.toFixed(1)}%, watched ${Number.isFinite(watchedMin) ? watchedMin.toFixed(0) : "?"}m`;

  const suspect = isPnlSuspect({
    pnl_pct: sig.pnl_pct,
    pnl_pct_suspicious: sig.pnl_pct_suspicious ?? false,
    total_value_usd: sig.total_value_usd ?? null,
  });
  if (!suspect && sig.pnl_pct != null) {
    const base = Math.max(1e-6, 1 + watch.trigger_pnl_pct / 100);
    const change = ((1 + sig.pnl_pct / 100) / base - 1) * 100;
    const now_ = `value ${change >= 0 ? "+" : ""}${change.toFixed(1)}% since trigger (pnl ${sig.pnl_pct.toFixed(1)}%; ${tail})`;
    if (change >= cfg.bounceTakePct) {
      return { action: "CLOSE", outcome: "take", reason: `${BOUNCE_REASON_PREFIX} (take): ${now_}` };
    }
    if (change <= -cfg.bounceStopPct) {
      return { action: "CLOSE", outcome: "stop", reason: `${BOUNCE_REASON_PREFIX} (stop): ${now_}` };
    }
    if (watchedMin >= cfg.bounceTimeoutMin) {
      return { action: "CLOSE", outcome: "timeout", reason: `${BOUNCE_REASON_PREFIX} (timeout ${cfg.bounceTimeoutMin}m): ${now_}` };
    }
    return { action: "HOLD", reason: `${BOUNCE_REASON_PREFIX} watching: ${now_}` };
  }
  if (watchedMin >= cfg.bounceTimeoutMin) {
    return {
      action: "CLOSE",
      outcome: "timeout",
      reason: `${BOUNCE_REASON_PREFIX} (timeout ${cfg.bounceTimeoutMin}m): pnl unreadable (${tail})`,
    };
  }
  return { action: "HOLD", reason: `${BOUNCE_REASON_PREFIX} watching: pnl unreadable (${tail})` };
}

export type BounceSimulation =
  | { ok: true; outcome: BounceOutcome; multiplier: number; minutesToExit: number; candles: number }
  | { ok: false; reason: string };

/**
 * Pure — replay a bounce watch over SOL-quoted 5m candles after a close at `closeTs`
 * (unix seconds). Anchor = close of the candle in progress at the close. Within each
 * later candle the stop is checked before the take (worst case: a 5m bar's order of
 * high/low is unknown). Returns price-at-exit ÷ price-at-trigger.
 */
export function simulateBounceExit(
  candles: readonly KlineCandle[],
  closeTs: number,
  cfg: BounceConfig,
): BounceSimulation {
  const sorted = [...candles].filter((c) => c.c > 0 && c.h > 0 && c.l > 0).sort((a, b) => a.t - b.t);
  const anchor = sorted.filter((c) => c.t <= closeTs).at(-1);
  if (!anchor || closeTs - anchor.t > MAX_ANCHOR_GAP_SEC) return { ok: false, reason: "no candle at the close" };
  const p0 = anchor.c;
  const endTs = closeTs + cfg.bounceTimeoutMin * 60;
  const window = sorted.filter((c) => c.t > anchor.t && c.t < endTs);
  if (window.length === 0) return { ok: false, reason: "no candles after the close" };
  const stopPx = p0 * (1 - cfg.bounceStopPct / 100);
  const takePx = p0 * (1 + cfg.bounceTakePct / 100);
  for (const [i, c] of window.entries()) {
    const minutesToExit = Math.max(0, (c.t + CANDLE_SEC - closeTs) / 60);
    if (c.l <= stopPx) return { ok: true, outcome: "stop", multiplier: stopPx / p0, minutesToExit, candles: i + 1 };
    if (c.h >= takePx) return { ok: true, outcome: "take", multiplier: takePx / p0, minutesToExit, candles: i + 1 };
  }
  return {
    ok: true,
    outcome: "timeout",
    multiplier: window.at(-1)!.c / p0,
    minutesToExit: cfg.bounceTimeoutMin,
    candles: window.length,
  };
}

/**
 * Net pnl % the closed position would have shown after the bounce. The price leg
 * (pnl_usd, fees excluded) is scaled by the multiplier; fees already earned stay.
 * Treats the position as all token at the close — exact for OOR-below, an
 * over-statement of sensitivity for a catastrophic close still inside the range.
 */
export function bounceShadowNetPct(
  perf: {
    pnl_pct: number;
    pnl_usd?: number | null | undefined;
    fees_earned_usd?: number | null | undefined;
    initial_value_usd?: number | null | undefined;
  },
  multiplier: number,
): number {
  const initial = perf.initial_value_usd;
  if (initial != null && initial > 0 && perf.pnl_usd != null) {
    const priceFrac = perf.pnl_usd / initial;
    const feeFrac = (perf.fees_earned_usd ?? 0) / initial;
    return ((1 + priceFrac) * multiplier - 1 + feeFrac) * 100;
  }
  return ((1 + perf.pnl_pct / 100) * multiplier - 1) * 100;
}
