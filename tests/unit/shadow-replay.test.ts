import { describe, expect, it } from "vitest";
import type { Lesson, PerformanceRecord } from "../../src/domain/schemas/lesson.js";
import { PerformanceRecordSchema } from "../../src/domain/schemas/lesson.js";
import type { KlineCandle } from "../../src/domain/schemas/kline.js";
import { computeShadowReplay, shadowDelta, tallyShadow } from "../../src/app/learning/shadow-replay.js";
import { runCloseReview } from "../../src/app/learning/close-review.js";
import { createFakeKlineClient } from "../../src/adapters/market/fake-kline.js";
import { createFakeLLM } from "../../src/adapters/llm/fake.js";
import { createCollectingNotifier } from "../../src/adapters/notify/collecting-notifier.js";
import { makeCtx, memLessonRepo } from "./tool-context.js";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const CLOSE = new Date(NOW.getTime() - 30 * 60_000);
const closeTs = Math.floor(CLOSE.getTime() / 1000);
const HOLD_MIN = 60;
const openTs = closeTs - HOLD_MIN * 60;

/** SOL-quoted 5m candles: flat at 1 before deploy, then a slide 25 bins down (1% bins). */
function slide(): KlineCandle[] {
  const out: KlineCandle[] = [];
  for (let t = openTs - 3600; t <= closeTs; t += 300) {
    const k = t < openTs ? 0 : Math.min(25, ((t - openTs) / 3000) * 25);
    const c = Math.pow(1.01, -k);
    out.push({ t, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 });
  }
  return out;
}

const perf = (over: Partial<PerformanceRecord> = {}): PerformanceRecord => ({
  position: "pos1",
  pool: "POOL1",
  pool_name: "TEST-SOL",
  pnl_pct: -9,
  pnl_usd: -10,
  fees_earned_usd: 1,
  initial_value_usd: 100,
  pnl_source: "meteora_closed",
  close_reason: "stop loss",
  strategy: "spot",
  amount_sol: 0.5,
  bin_range: { min: -69, max: 0 },
  bin_step: 100,
  minutes_held: HOLD_MIN,
  closed_at: CLOSE.toISOString(),
  recorded_at: CLOSE.toISOString(),
  ...over,
});

describe("computeShadowReplay", () => {
  it("replays spot and bid_ask from SOL candles; bid_ask loses less on a slide", async () => {
    const kline = createFakeKlineClient();
    kline.set("POOL1", "5m", slide());
    const ctx = makeCtx({ market: { kline } });
    const s = await computeShadowReplay(ctx, perf());
    expect(s).not.toBeNull();
    expect(s!.actual_strategy).toBe("spot");
    expect(s!.exit_bin_offset).toBeCloseTo(25, 0);
    const [spot, ba] = s!.results;
    expect(spot!.strategy).toBe("spot");
    expect(spot!.fee_pct).toBeCloseTo(1, 9); // anchored to the real fees (1 / 100)
    expect(ba!.price_pct).toBeGreaterThan(spot!.price_pct);
    expect(PerformanceRecordSchema.safeParse({ ...perf(), shadow: s }).success).toBe(true);
  });

  it("returns null — never throws — without candles or range data", async () => {
    const ctx = makeCtx({ market: { kline: createFakeKlineClient() } });
    expect(await computeShadowReplay(ctx, perf())).toBeNull();
    expect(await computeShadowReplay(ctx, perf({ bin_step: undefined }))).toBeNull();
    const broken = makeCtx({
      market: { kline: { getKline: async () => { throw new Error("boom"); } } },
    });
    expect(await computeShadowReplay(broken, perf())).toBeNull();
  });
});

describe("tallyShadow", () => {
  const withShadow = (spot: number, ba: number, amount = 1): PerformanceRecord =>
    perf({
      amount_sol: amount,
      shadow: {
        method: "replay-5m-v1",
        computed_at: NOW.toISOString(),
        actual_strategy: "spot",
        entry_price_sol: 1,
        exit_price_sol: 1,
        exit_bin_offset: 0,
        candles: 10,
        results: [
          { strategy: "spot", price_pct: spot, fee_pct: 0, net_pct: spot, fee_ratio: 1 },
          { strategy: "bid_ask", price_pct: ba, fee_pct: 0, net_pct: ba, fee_ratio: 0.5 },
        ],
      },
    });

  it("scores bid_ask against spot in SOL, ignoring records without a shadow", () => {
    const t = tallyShadow([withShadow(-10, -4, 0.5), withShadow(2, 1, 1), perf()]);
    expect(t.n).toBe(2);
    expect(t.bidAskBetter).toBe(1);
    expect(t.deltaSol).toBeCloseTo(0.06 * 0.5 - 0.01, 12);
    expect(shadowDelta(perf())).toBeNull();
  });

});

describe("runCloseReview shadow mode", () => {
  it("stamps the shadow on the record without telling the LLM", async () => {
    const lessons = memLessonRepo();
    await lessons.appendPerformance(perf());
    const kline = createFakeKlineClient();
    kline.set("POOL1", "5m", slide());
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ repos: { lessons }, notifier, market: { kline } });
    const llm = createFakeLLM({ script: [{ kind: "assistant", text: "WHAT: a\nWHY: b\nLESSON: NONE" }] });

    await runCloseReview({ ctx, llm, model: "m" });

    const file = (await lessons.load()) as { ok: true; value: { lessons: Lesson[]; performance: PerformanceRecord[] } };
    const rec = file.value.performance[0]!;
    expect(rec.review).toBeDefined();
    expect(rec.shadow?.results.map((r) => r.strategy)).toEqual(["spot", "bid_ask"]);
    // The reviewer prompt must not carry the shadow — it is observation only for now.
    expect(llm.callCount()).toBeGreaterThan(0);
    const sent = JSON.stringify(llm.requests());
    expect(sent).not.toContain("Shadow");
    expect(sent).not.toContain("shadow");
  });
});
