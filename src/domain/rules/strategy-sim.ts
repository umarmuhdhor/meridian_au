/**
 * Counterfactual replay of a single-side-SOL DLMM position under a different
 * liquidity shape. Pure — the caller supplies the candles.
 *
 * Why this is trustworthy enough to decide on: a DLMM position's composition is
 * path-INDEPENDENT. Whatever the path, at a given final price every bin above it
 * holds SOL and every bin it fell through holds token bought at that bin's price.
 * So the ex-fee result of any shape is exact given the entry price, the exit price
 * and the bin weights. Only the fee side is an estimate: fees are attributed to
 * each bin in proportion to our weight there × the volume that traded through it,
 * then scaled so the actual strategy reproduces the fees it really earned.
 *
 * Coordinates: k = bins BELOW the entry active bin (k=0 is the active bin,
 * k grows as price falls). A position spanning N bins covers k ∈ [0, N).
 */
import type { KlineCandle } from "../schemas/kline.js";
import type { LpStrategy } from "./deploy-planning.js";

/** Candle length the replay is calibrated for (GeckoTerminal 5m). */
export const REPLAY_CANDLE_SEC = 300;
export const REPLAY_METHOD = "replay-5m-v1";

/**
 * Capital fraction per bin, index 0 = entry active bin. Mirrors the SDK's
 * one-sided-Y builders: spot is flat, bid_ask grows linearly away from the active
 * bin (`findY0AndDeltaY`), curve shrinks linearly away from it.
 */
export function strategyWeights(strategy: LpStrategy, nBins: number): number[] {
  const raw = Array.from({ length: nBins }, (_, k) =>
    strategy === "spot" ? 1 : strategy === "bid_ask" ? k + 1 : nBins - k,
  );
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / total);
}

/** Continuous bin offset below the entry bin for `price` (negative = above entry). */
export function binOffset(price: number, entryPrice: number, binStep: number): number {
  return -Math.log(price / entryPrice) / Math.log(1 + binStep / 10_000);
}

/**
 * Position value at `price`, in units of the deposited SOL (1 = break-even, fees
 * excluded). Bin k converts SOL→token as the offset passes through [k, k+1], at
 * the bin's mid price.
 */
export function valueAtPrice(weights: number[], price: number, entryPrice: number, binStep: number): number {
  const kp = binOffset(price, entryPrice, binStep);
  const r = 1 + binStep / 10_000;
  let value = 0;
  weights.forEach((w, k) => {
    const filled = Math.min(1, Math.max(0, kp - k));
    const binPrice = entryPrice * Math.pow(r, -(k + 0.5));
    value += w * ((1 - filled) + (filled * price) / binPrice);
  });
  return value;
}

/**
 * Relative fee capture: Σ over candles of volume × our average weight across the
 * bins the candle traded through. Only ratios between shapes are meaningful.
 * A candle's range is widened to at least one bin so a flat candle still counts.
 */
export function feeScore(weights: number[], candles: readonly KlineCandle[], entryPrice: number, binStep: number): number {
  const n = weights.length;
  let score = 0;
  for (const c of candles) {
    if (!(c.v > 0) || !(c.h > 0) || !(c.l > 0)) continue;
    let lo = binOffset(c.h, entryPrice, binStep);
    let hi = binOffset(c.l, entryPrice, binStep);
    if (hi - lo < 1) {
      const mid = binOffset(c.c, entryPrice, binStep);
      lo = mid - 0.5;
      hi = mid + 0.5;
    }
    let covered = 0;
    for (let k = Math.max(0, Math.floor(lo)); k < Math.min(n, Math.ceil(hi)); k++) {
      const overlap = Math.min(hi, k + 1) - Math.max(lo, k);
      if (overlap > 0) covered += overlap * (weights[k] ?? 0);
    }
    score += (c.v * covered) / (hi - lo);
  }
  return score;
}

export interface ReplayInput {
  nBins: number;
  binStep: number;
  entryPrice: number;
  exitPrice: number;
  /** Candles between deploy and close. */
  candles: readonly KlineCandle[];
  /** The shape that was actually deployed — its fees anchor the estimate. */
  actualStrategy: LpStrategy;
  /** Fees really earned, as a fraction of the deposit. */
  actualFeeFrac: number;
}

export interface ReplayResult {
  strategy: LpStrategy;
  /** Ex-fee result as a fraction of the deposit (exact given entry/exit price). */
  priceFrac: number;
  /** Estimated fees as a fraction of the deposit. */
  feeFrac: number;
  netFrac: number;
  /** Fee capture relative to the actual strategy (1 = same). */
  feeRatio: number;
}

export function replayStrategies(input: ReplayInput, strategies: LpStrategy[]): ReplayResult[] {
  const { nBins, binStep, entryPrice, exitPrice, candles } = input;
  const baseScore = feeScore(strategyWeights(input.actualStrategy, nBins), candles, entryPrice, binStep);
  return strategies.map((strategy) => {
    const w = strategyWeights(strategy, nBins);
    const priceFrac = valueAtPrice(w, exitPrice, entryPrice, binStep) - 1;
    // No in-range volume seen for the actual shape → no basis to rescale; assume parity.
    const feeRatio = baseScore > 0 ? feeScore(w, candles, entryPrice, binStep) / baseScore : 1;
    const feeFrac = input.actualFeeFrac * feeRatio;
    return { strategy, priceFrac, feeFrac, netFrac: priceFrac + feeFrac, feeRatio };
  });
}

export interface RecordReplayInput {
  /** Unix seconds. */
  openTs: number;
  closeTs: number;
  /** The deployed range; single-side SOL, so `max` is the entry active bin. */
  binRange: { min: number; max: number };
  binStep: number;
  actualStrategy: LpStrategy;
  actualFeeFrac: number;
  /**
   * USD price at entry (entry technicals' last close), when known. Used only to catch
   * a pool quoted the other way round (SOL as base), where the SOL-denominated
   * candles would be inverted.
   */
  usdEntryPrice?: number | null | undefined;
}

export type RecordReplay =
  | {
      ok: true;
      entryPrice: number;
      exitPrice: number;
      exitBinOffset: number;
      candles: number;
      results: ReplayResult[];
    }
  | { ok: false; reason: string };

/**
 * Replay one closed position from SOL-quoted candles (any order, any span that
 * covers the hold). Entry price = close of the last candle that finished before the
 * deploy; exit = close of the candle holding the close.
 */
export function replayRecord(
  input: RecordReplayInput,
  candles: readonly KlineCandle[],
  strategies: LpStrategy[],
): RecordReplay {
  const { openTs, closeTs } = input;
  const inWindow = candles
    .filter((c) => c.t + REPLAY_CANDLE_SEC > openTs && c.t <= closeTs)
    .sort((a, b) => a.t - b.t);
  const pre = candles.filter((c) => c.t <= openTs - REPLAY_CANDLE_SEC).sort((a, b) => b.t - a.t)[0];
  const entryCandle = pre ?? inWindow[0];
  const exitCandle = inWindow[inWindow.length - 1];
  if (!entryCandle || !exitCandle) return { ok: false, reason: "no candles for the hold window" };
  const entryPrice = entryCandle.c;
  const exitPrice = exitCandle.c;
  if (!(entryPrice > 0) || !(exitPrice > 0)) return { ok: false, reason: "non-positive price" };
  const usd = input.usdEntryPrice;
  if (usd && (usd / entryPrice < 20 || usd / entryPrice > 2000)) {
    return { ok: false, reason: `quote looks inverted (usd/token=${(usd / entryPrice).toFixed(3)})` };
  }
  const nBins = input.binRange.max - input.binRange.min + 1;
  if (!(nBins > 0)) return { ok: false, reason: "empty bin range" };
  const results = replayStrategies(
    {
      nBins,
      binStep: input.binStep,
      entryPrice,
      exitPrice,
      candles: inWindow,
      actualStrategy: input.actualStrategy,
      actualFeeFrac: input.actualFeeFrac,
    },
    strategies,
  );
  return {
    ok: true,
    entryPrice,
    exitPrice,
    exitBinOffset: binOffset(exitPrice, entryPrice, input.binStep),
    candles: inWindow.length,
    results,
  };
}
