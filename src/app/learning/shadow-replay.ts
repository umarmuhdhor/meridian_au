/**
 * Shadow mode (2026-10-08): after a close settles, replay the same pool / range / hold
 * under the other liquidity shapes and record what they would have returned. Zero-risk
 * evidence for the spot-vs-bid_ask question — no trade is placed, and nothing feeds the
 * result back into screening or lesson writing (that is the later, opt-in probe step).
 *
 * The replay itself is pure (domain/rules/strategy-sim.ts); this module only fetches the
 * SOL-quoted 5m candles and shapes the record. Never throws — a missing shadow is fine.
 */
import type { AppContext } from "../tools/context.js";
import type { LpStrategy } from "../../domain/rules/deploy-planning.js";
import type { PerformanceRecord, ShadowReplay } from "../../domain/schemas/lesson.js";
import { REPLAY_CANDLE_SEC, REPLAY_METHOD, replayRecord } from "../../domain/rules/strategy-sim.js";

/** Shapes replayed. curve is banned (user mandate 2026-09-25), so it is not tracked. */
export const SHADOW_STRATEGIES: LpStrategy[] = ["spot", "bid_ask"];
/** One GT page — holds longer than this (≈83h) are not replayed. */
const MAX_CANDLES = 1000;

export async function computeShadowReplay(
  ctx: Pick<AppContext, "market" | "clock" | "logger">,
  perf: PerformanceRecord,
): Promise<ShadowReplay | null> {
  const tag = `${perf.pool_name ?? perf.position.slice(0, 8)}`;
  const skip = (reason: string): null => {
    ctx.logger.info("shadow-replay", `no shadow for ${tag}: ${reason}`);
    return null;
  };
  const { pool, bin_range: range, bin_step: binStep, closed_at, minutes_held, initial_value_usd } = perf;
  if (!pool || range?.min === undefined || range.max === undefined || !binStep) return skip("no pool/range/bin_step");
  if (!closed_at || minutes_held === undefined || !initial_value_usd || initial_value_usd <= 0) {
    return skip("no close time / hold / entry value");
  }
  const closeTs = Math.floor(Date.parse(closed_at) / 1000);
  const openTs = closeTs - minutes_held * 60;
  if (minutes_held * 60 > (MAX_CANDLES - 2) * REPLAY_CANDLE_SEC) return skip("hold longer than one candle page");

  try {
    const candles = await ctx.market.kline.getKline(pool, "5m", {
      limit: MAX_CANDLES,
      currency: "token",
      beforeTs: closeTs + 2 * REPLAY_CANDLE_SEC,
    });
    if (candles.length === 0) return skip("no candles (GeckoTerminal empty / rate-limited)");
    const actualStrategy = perf.strategy ?? "spot";
    const usdEntry = perf.entry_technicals?.find((t) => t.timeframe === "15m")?.last_close ?? null;
    const r = replayRecord(
      {
        openTs,
        closeTs,
        binRange: { min: range.min, max: range.max },
        binStep,
        actualStrategy,
        actualFeeFrac: (perf.fees_earned_usd ?? 0) / initial_value_usd,
        usdEntryPrice: usdEntry,
      },
      candles,
      SHADOW_STRATEGIES.includes(actualStrategy) ? SHADOW_STRATEGIES : [actualStrategy, ...SHADOW_STRATEGIES],
    );
    if (!r.ok) return skip(r.reason);
    return {
      method: REPLAY_METHOD,
      computed_at: ctx.clock.now().toISOString(),
      actual_strategy: actualStrategy,
      entry_price_sol: r.entryPrice,
      exit_price_sol: r.exitPrice,
      exit_bin_offset: r.exitBinOffset,
      candles: r.candles,
      results: r.results.map((x) => ({
        strategy: x.strategy,
        price_pct: x.priceFrac * 100,
        fee_pct: x.feeFrac * 100,
        net_pct: x.netFrac * 100,
        fee_ratio: x.feeRatio,
      })),
    };
  } catch (e) {
    return skip(e instanceof Error ? e.message : String(e));
  }
}

export interface ShadowTally {
  /** Closes with a spot-vs-bid_ask shadow. */
  n: number;
  /** …of which bid_ask came out ahead. */
  bidAskBetter: number;
  /** Σ (bid_ask − spot) net, in SOL, sized by each position's amount_sol. */
  deltaSol: number;
}

/** Pure — running score of the shadow experiment over every recorded close. */
export function tallyShadow(performance: readonly PerformanceRecord[]): ShadowTally {
  const t: ShadowTally = { n: 0, bidAskBetter: 0, deltaSol: 0 };
  for (const p of performance) {
    const d = shadowDelta(p);
    if (d === null) continue;
    t.n++;
    if (d > 0) t.bidAskBetter++;
    t.deltaSol += (d / 100) * (p.amount_sol ?? 0);
  }
  return t;
}

/** bid_ask net − spot net (percentage points) from a record's shadow, or null. */
export function shadowDelta(p: PerformanceRecord): number | null {
  const by = new Map((p.shadow?.results ?? []).map((r) => [r.strategy, r.net_pct]));
  const spot = by.get("spot");
  const ba = by.get("bid_ask");
  return spot === undefined || ba === undefined ? null : ba - spot;
}
