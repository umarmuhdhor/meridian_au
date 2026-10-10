import { describe, expect, it } from "vitest";
import { binOffset, feeScore, replayRecord, replayStrategies, strategyWeights, valueAtPrice } from "../../src/domain/rules/strategy-sim.js";

const STEP = 100; // 1% bins
const P0 = 1;
const priceAtBin = (k: number) => P0 * Math.pow(1.01, -k);

describe("strategyWeights", () => {
  it("normalises every shape to 1 and orders mass the way the SDK does", () => {
    for (const s of ["spot", "bid_ask", "curve"] as const) {
      expect(strategyWeights(s, 70).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
    const ba = strategyWeights("bid_ask", 10);
    expect(ba[9]).toBeGreaterThan(ba[0]!); // heaviest far from the active bin
    const cv = strategyWeights("curve", 10);
    expect(cv[0]).toBeGreaterThan(cv[9]!);
  });
});

describe("valueAtPrice", () => {
  it("is exactly break-even at or above entry — the position is all SOL", () => {
    for (const s of ["spot", "bid_ask"] as const) {
      const w = strategyWeights(s, 70);
      expect(valueAtPrice(w, P0, P0, STEP)).toBeCloseTo(1, 12);
      expect(valueAtPrice(w, P0 * 1.5, P0, STEP)).toBeCloseTo(1, 12);
    }
  });

  it("bid_ask loses less than spot on any fall, because it buys lower", () => {
    for (const k of [5, 20, 50, 69, 120]) {
      const spot = valueAtPrice(strategyWeights("spot", 70), priceAtBin(k), P0, STEP);
      const ba = valueAtPrice(strategyWeights("bid_ask", 70), priceAtBin(k), P0, STEP);
      expect(ba).toBeGreaterThan(spot);
      expect(spot).toBeLessThan(1);
    }
  });

  it("below the range the loss is the full fall from each bin's buy price", () => {
    const w = strategyWeights("spot", 1);
    const below = priceAtBin(10);
    expect(valueAtPrice(w, below, P0, STEP)).toBeCloseTo(below / priceAtBin(0.5), 10);
  });
});

describe("feeScore / replayStrategies", () => {
  it("trading at the entry bin favours spot; trading deep in the range favours bid_ask", () => {
    const near = [{ t: 0, o: priceAtBin(1), h: priceAtBin(0), l: priceAtBin(2), c: priceAtBin(1), v: 1000 }];
    const deep = [{ t: 0, o: priceAtBin(63), h: priceAtBin(60), l: priceAtBin(66), c: priceAtBin(63), v: 1000 }];
    const spot = strategyWeights("spot", 70);
    const ba = strategyWeights("bid_ask", 70);
    expect(feeScore(spot, near, P0, STEP)).toBeGreaterThan(feeScore(ba, near, P0, STEP));
    expect(feeScore(ba, deep, P0, STEP)).toBeGreaterThan(feeScore(spot, deep, P0, STEP));
  });

  it("reproduces the actual strategy's fees exactly and rescales the others", () => {
    const candles = [{ t: 0, o: priceAtBin(20), h: priceAtBin(0), l: priceAtBin(30), c: priceAtBin(20), v: 500 }];
    const [spot, ba] = replayStrategies(
      { nBins: 70, binStep: STEP, entryPrice: P0, exitPrice: priceAtBin(20), candles, actualStrategy: "spot", actualFeeFrac: 0.02 },
      ["spot", "bid_ask"],
    );
    expect(spot!.feeFrac).toBeCloseTo(0.02, 12);
    expect(spot!.feeRatio).toBe(1);
    expect(ba!.feeRatio).toBeLessThan(1); // volume sat in the light upper half
    expect(ba!.priceFrac).toBeGreaterThan(spot!.priceFrac);
  });

  it("binOffset is 0 at entry and grows as price falls", () => {
    expect(binOffset(P0, P0, STEP)).toBeCloseTo(0, 12);
    expect(binOffset(priceAtBin(7), P0, STEP)).toBeCloseTo(7, 9);
  });
});

describe("replayRecord", () => {
  const candle = (t: number, c: number, v = 100) => ({ t, o: c, h: c * 1.005, l: c * 0.995, c, v });
  const base = {
    openTs: 1_000_000,
    closeTs: 1_000_000 + 3600,
    binRange: { min: -69, max: 0 },
    binStep: STEP,
    actualStrategy: "spot" as const,
    actualFeeFrac: 0.01,
  };

  it("prices entry from the candle before deploy and exit from the closing candle", () => {
    const cs = [candle(base.openTs - 600, 1), candle(base.openTs - 300, 1), candle(base.openTs + 1800, 0.9), candle(base.closeTs - 100, priceAtBin(20))];
    const r = replayRecord(base, cs, ["spot", "bid_ask"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entryPrice).toBe(1);
    expect(r.exitBinOffset).toBeCloseTo(20, 6);
    expect(r.results[1]!.priceFrac).toBeGreaterThan(r.results[0]!.priceFrac);
  });

  it("refuses without candles, and on an inverted quote", () => {
    expect(replayRecord(base, [], ["spot"]).ok).toBe(false);
    const cs = [candle(base.openTs - 300, 1), candle(base.closeTs - 100, 1)];
    // usd/token = 1 → the "SOL" candles are really USD or inverted.
    const r = replayRecord({ ...base, usdEntryPrice: 1 }, cs, ["spot"]);
    expect(r.ok).toBe(false);
  });
});
