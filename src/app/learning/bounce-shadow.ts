/**
 * Bounce-exit shadow (2026-10-10). Every deep-loss close that sold at once (CATASTROPHIC
 * floor / OOR-below DYING) gets a `bounce_shadow` stamped on its PerformanceRecord once
 * the watch window has passed: what waiting for a rebound — take / stop / timeout per
 * the current bounce config — would have returned instead. This is the evidence for (or
 * against) arming `bounceExitEnabled`; it runs whether the feature is on or off, and
 * nothing reads it back into a trading decision.
 *
 * The replay is pure (domain/rules/bounce-exit.ts `simulateBounceExit`); this module only
 * fetches SOL-quoted 5m candles and writes the record. Never throws.
 */
import type { AppContext } from "../tools/context.js";
import type { BounceShadow, PerformanceRecord } from "../../domain/schemas/lesson.js";
import {
  BOUNCE_SHADOW_METHOD,
  bounceShadowNetPct,
  isBounceEligibleCloseReason,
  simulateBounceExit,
} from "../../domain/rules/bounce-exit.js";

/** GeckoTerminal is keyless and rate-limited — a few deep losses a day, so 2 per tick is plenty. */
export const BOUNCE_SHADOW_MAX_PER_TICK = 2;
/** Older closes are not replayed (candles are fetched back from close + window only). */
const LOOKBACK_MS = 72 * 3_600_000;
/** Wait a little past the window so the last candle has been published. */
const SETTLE_MS = 15 * 60_000;
/** Give up on a record after this many failed replays (empty candles / GT 429). */
const MAX_ATTEMPTS = 6;
/**
 * The replay assumes the position was (mostly) token when it was sold, so value tracks
 * price. A "catastrophic" close at ~0% is a datapi misread on a fresh, still-all-SOL
 * deposit (OTC-SOL / FLAME-SOL, Sep 2026 — pre warm-up), where waiting changes nothing;
 * replaying it would invent a +take% win.
 */
const MIN_LOSS_PCT = -5;
const CANDLE_LIMIT = 1000;

type ShadowCtx = Pick<AppContext, "market" | "clock" | "logger" | "config" | "repos">;

/** Pure — closes due for a bounce shadow at `now`, oldest first. */
export function pickBounceShadowable(
  performance: readonly PerformanceRecord[],
  now: Date,
  timeoutMin: number,
  attempts: ReadonlyMap<string, number> = new Map(),
  limit = BOUNCE_SHADOW_MAX_PER_TICK,
): PerformanceRecord[] {
  const nowMs = now.getTime();
  return performance
    .filter((p) => {
      if (p.bounce_shadow || !p.pool || !p.closed_at) return false;
      if (!isBounceEligibleCloseReason(p.close_reason) || !(p.pnl_pct <= MIN_LOSS_PCT)) return false;
      if ((attempts.get(p.position) ?? 0) >= MAX_ATTEMPTS) return false;
      const age = nowMs - Date.parse(p.closed_at);
      return Number.isFinite(age) && age >= timeoutMin * 60_000 + SETTLE_MS && age <= LOOKBACK_MS;
    })
    .sort((a, b) => Date.parse(a.closed_at!) - Date.parse(b.closed_at!))
    .slice(0, limit);
}

export async function computeBounceShadow(ctx: ShadowCtx, perf: PerformanceRecord): Promise<BounceShadow | null> {
  const cfg = ctx.config.management;
  const tag = perf.pool_name ?? perf.position.slice(0, 8);
  const closeTs = Math.floor(Date.parse(perf.closed_at!) / 1000);
  const candles = await ctx.market.kline.getKline(perf.pool!, "5m", {
    limit: CANDLE_LIMIT,
    currency: "token",
    beforeTs: closeTs + cfg.bounceTimeoutMin * 60 + 600,
  });
  const sim = simulateBounceExit(candles, closeTs, cfg);
  if (!sim.ok) {
    ctx.logger.info("bounce-shadow", `no bounce shadow for ${tag}: ${sim.reason}`);
    return null;
  }
  const shadowNet = bounceShadowNetPct(perf, sim.multiplier);
  return {
    method: BOUNCE_SHADOW_METHOD,
    computed_at: ctx.clock.now().toISOString(),
    take_pct: cfg.bounceTakePct,
    stop_pct: cfg.bounceStopPct,
    timeout_min: cfg.bounceTimeoutMin,
    outcome: sim.outcome,
    multiplier: sim.multiplier,
    minutes_to_exit: sim.minutesToExit,
    candles: sim.candles,
    actual_net_pct: perf.pnl_pct,
    shadow_net_pct: shadowNet,
    delta_pct: shadowNet - perf.pnl_pct,
  };
}

/** One tick: replay up to BOUNCE_SHADOW_MAX_PER_TICK due closes and stamp them. Never throws. */
export async function runBounceShadow(ctx: ShadowCtx, attempts: Map<string, number> = new Map()): Promise<number> {
  let stamped = 0;
  try {
    const loaded = await ctx.repos.lessons.load();
    if (!loaded.ok) return 0;
    const due = pickBounceShadowable(loaded.value.performance, ctx.clock.now(), ctx.config.management.bounceTimeoutMin, attempts);
    for (const perf of due) {
      let shadow: BounceShadow | null = null;
      try {
        shadow = await computeBounceShadow(ctx, perf);
      } catch (e) {
        ctx.logger.warn("bounce-shadow", `replay failed for ${perf.position.slice(0, 8)}`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      if (!shadow) {
        attempts.set(perf.position, (attempts.get(perf.position) ?? 0) + 1);
        continue;
      }
      // Re-load right before the write: other jobs append to lessons.json too.
      const fresh = await ctx.repos.lessons.load();
      if (!fresh.ok) return stamped;
      const file = fresh.value;
      const idx = file.performance.findLastIndex((p) => p.position === perf.position);
      if (idx < 0 || file.performance[idx]!.bounce_shadow) continue;
      file.performance[idx] = { ...file.performance[idx]!, bounce_shadow: shadow };
      await ctx.repos.lessons.save(file);
      stamped++;
      ctx.logger.info("bounce-shadow", `${perf.pool_name ?? perf.position.slice(0, 8)} → ${shadow.outcome}`, {
        actual_net_pct: Number(shadow.actual_net_pct.toFixed(2)),
        shadow_net_pct: Number(shadow.shadow_net_pct.toFixed(2)),
        delta_pct: Number(shadow.delta_pct.toFixed(2)),
        minutes_to_exit: Math.round(shadow.minutes_to_exit),
      });
    }
  } catch (e) {
    ctx.logger.warn("bounce-shadow", "tick failed", { error: e instanceof Error ? e.message : String(e) });
  }
  return stamped;
}

export interface BounceShadowTally {
  n: number;
  /** …of which waiting would have beaten the immediate sale. */
  better: number;
  /** Σ (shadow − actual), in SOL, sized by each position's amount_sol. */
  deltaSol: number;
}

/** Pure — running score of the bounce experiment over every stamped close. */
export function tallyBounceShadow(performance: readonly PerformanceRecord[]): BounceShadowTally {
  const t: BounceShadowTally = { n: 0, better: 0, deltaSol: 0 };
  for (const p of performance) {
    if (!p.bounce_shadow) continue;
    t.n++;
    if (p.bounce_shadow.delta_pct > 0) t.better++;
    t.deltaSol += (p.bounce_shadow.delta_pct / 100) * (p.amount_sol ?? 0);
  }
  return t;
}
