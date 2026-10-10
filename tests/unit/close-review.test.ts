import { describe, expect, it } from "vitest";
import type { Lesson, PerformanceRecord } from "../../src/domain/schemas/lesson.js";
import type { AppConfig } from "../../src/domain/schemas/config.js";
import type { TechnicalsSummary } from "../../src/domain/schemas/kline.js";
import type { LLMClient } from "../../src/ports/llm-client.js";
import {
  CLOSE_REVIEW_MAX_LLM_ATTEMPTS,
  CLOSE_REVIEW_MAX_REFINES,
  backfillCloseReviews,
  pickBackfillable,
  CLOSE_REVIEW_SETTLE_WAIT_MS,
  classifyOutcome,
  parseCloseReview,
  pickReviewable,
  runCloseReview,
} from "../../src/app/learning/close-review.js";
import { createFakeLLM } from "../../src/adapters/llm/fake.js";
import { createCollectingNotifier } from "../../src/adapters/notify/collecting-notifier.js";
import { makeCtx, memFollowRepo, memLessonRepo } from "./tool-context.js";
import { mgmt } from "./fixtures.js";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const tech = (timeframe: string, over: Partial<TechnicalsSummary> = {}): TechnicalsSummary =>
  ({
    timeframe,
    candles: 100,
    last_close: 1,
    spike_pct: 31,
    at_local_top: true,
    at_local_bottom: false,
    atr_pct: 9,
    vol_spike: 1,
    trend: "UP",
    from_window_high_pct: -3,
    nearest_support: 0.9,
    support_distance_pct: -10,
    support_touches: 1,
    consecutive_red_count: 0,
    ...over,
  }) as TechnicalsSummary;

/** An entry the REPLY's MATCH does not catch — a calm, non-spiking setup. */
const calm = [tech("15m", { spike_pct: 4, at_local_top: false })];

const perf = (position: string, over: Partial<PerformanceRecord> = {}): PerformanceRecord => ({
  position,
  pool: `pool-${position}`,
  pool_name: `${position.toUpperCase()}-SOL`,
  pnl_pct: -4.2,
  pnl_usd: -3,
  fees_earned_usd: 1,
  pnl_source: "meteora_closed",
  close_reason: "stop loss",
  strategy: "spot",
  fee_tvl_ratio: 0.4,
  entry_technicals: [tech("15m")],
  closed_at: minsAgo(30),
  recorded_at: minsAgo(30),
  ...over,
});

async function seed(lessons: Lesson[], records: PerformanceRecord[]) {
  const repo = memLessonRepo();
  for (const l of lessons) await repo.addLesson(l);
  for (const r of records) await repo.appendPerformance(r);
  return repo;
}

const REPLY = [
  "WHAT: Price fell 12% below the range within 40 minutes.",
  "WHY: Entered at_local_top=YES with a 15m spike of +31%.",
  "LESSON: AVOID deploying when 15m spike_pct > 25% and at_local_top=YES.",
  "MATCH: 15m.spike > 25 AND 15m.at_local_top = YES",
].join("\n");

describe("classifyOutcome", () => {
  it("uses net pnl (fees included)", () => {
    expect(classifyOutcome(perf("a", { pnl_pct: 1.5, pnl_usd: -0.5, fees_earned_usd: 2 }))).toEqual({
      outcome: "win",
      net_usd: 1.5,
    });
    expect(classifyOutcome(perf("a", { pnl_pct: 0 })).outcome).toBe("loss");
  });
});

describe("pickReviewable", () => {
  it("skips reviewed, mirrored, stale and not-yet-settled records; newest first", () => {
    const records = [
      perf("old", { closed_at: minsAgo(60 * 30) }),
      perf("done", { review: { reviewed_at: minsAgo(1), outcome: "loss", lessons_applied: [] } }),
      perf("mirror"),
      perf("fresh-est", { pnl_source: "estimate", closed_at: minsAgo(2) }),
      perf("waited-est", { pnl_source: "estimate", closed_at: minsAgo(CLOSE_REVIEW_SETTLE_WAIT_MS / 60_000 + 1) }),
      perf("settled", { closed_at: minsAgo(3) }),
    ];
    const got = pickReviewable(records, NOW, new Set(["mirror"]));
    expect(got.map((p) => p.position)).toEqual(["settled", "waited-est"]);
  });
});

describe("parseCloseReview", () => {
  it("extracts the three lines", () => {
    expect(parseCloseReview(REPLY)).toEqual({
      what: "Price fell 12% below the range within 40 minutes.",
      why: "Entered at_local_top=YES with a 15m spike of +31%.",
      rule: "AVOID deploying when 15m spike_pct > 25% and at_local_top=YES.",
      match: "15m.spike > 25 AND 15m.at_local_top = YES",
    });
  });
  it("treats LESSON: NONE as no rule", () => {
    expect(parseCloseReview("WHAT: x\nWHY: y\nLESSON: NONE — already covered").rule).toBeNull();
  });
});

describe("runCloseReview", () => {
  it("writes an auto lesson, scores cited lessons, stamps the review without a Telegram card", async () => {
    const lessons = await seed(
      [{ id: "l-cited", rule: "PREFER sideways volume", tags: [], pinned: true, stats: { applied: 2, wins: 2, losses: 0 } }],
      [perf("aaa", { lessons_applied: ["l-cited", "l-gone"], entry_reason: "high fee/tvl" })],
    );
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ repos: { lessons }, notifier });
    const llm = createFakeLLM({ script: [{ kind: "assistant", text: REPLY }] });

    const out = await runCloseReview({ ctx, llm, model: "m" });

    expect(out).toHaveLength(1);
    const file = (await lessons.load()) as { ok: true; value: { lessons: Lesson[]; performance: PerformanceRecord[] } };
    const auto = file.value.lessons.find((l) => l.sourceType === "close-review")!;
    expect(auto.rule).toBe(
      "[auto LOSS AAA-SOL -4.2%] AVOID deploying when 15m spike_pct > 25% and at_local_top=YES." +
        " {applies ONLY when: 15m.spike > 25 AND 15m.at_local_top = YES — history 0W/1L}",
    );
    expect(auto.match).toBe("15m.spike > 25 AND 15m.at_local_top = YES");
    expect(auto.backtest).toMatchObject({ wins: 0, losses: 1 });
    expect(auto.pinned).toBe(false);
    expect(auto.tags).toEqual(["auto", "close-review", "loss", "spot"]);

    const cited = file.value.lessons.find((l) => l.id === "l-cited")!;
    expect(cited.stats).toMatchObject({ applied: 3, wins: 2, losses: 1 });

    const review = file.value.performance[0]!.review!;
    expect(review.outcome).toBe("loss");
    expect(review.net_usd).toBe(-2);
    expect(review.lesson_id).toBe(auto.id);
    expect(review.lessons_applied).toEqual([
      { id: "l-cited", rule: "PREFER sideways volume" },
      { id: "l-gone", rule: null },
    ]);

    // The LLM saw the entry reason and the cited lesson text.
    const userMsg = llm.requests()[0]!.messages[1]!.content as string;
    expect(userMsg).toContain("Screener's reason for entering: high fee/tvl");
    expect(userMsg).toContain("[l-cited] PREFER sideways volume");

    // No Telegram card — the review lives on the dashboard only.
    expect(notifier.recorded.filter((r) => r.type === "notify")).toEqual([]);

    // Second pass: already reviewed → nothing re-scored.
    expect(await runCloseReview({ ctx, llm, model: "m" })).toEqual([]);
    const again = (await lessons.load()) as typeof file;
    expect(again.value.lessons.find((l) => l.id === "l-cited")!.stats!.applied).toBe(3);
  });

  it("LESSON: NONE still records the review and scores, without a new lesson", async () => {
    const lessons = await seed([], [perf("bbb", { pnl_pct: 3, pnl_usd: 2 })]);
    const ctx = makeCtx({ repos: { lessons } });
    const llm = createFakeLLM({ script: [{ kind: "assistant", text: "WHAT: a\nWHY: b\nLESSON: NONE" }] });
    const [r] = await runCloseReview({ ctx, llm, model: "m" });
    expect(r!.review).toMatchObject({ outcome: "win", lesson_id: null, note: "llm_none", what: "a" });
    expect((await lessons.listLessons()).length).toBe(0);
  });

  it("retries a failing LLM, then reviews without a lesson", async () => {
    const lessons = await seed([], [perf("ccc")]);
    const ctx = makeCtx({ repos: { lessons } });
    const llm: LLMClient = { chat: async () => { throw new Error("boom"); } };
    const attempts = new Map<string, number>();
    for (let i = 1; i < CLOSE_REVIEW_MAX_LLM_ATTEMPTS; i++) {
      expect(await runCloseReview({ ctx, llm, model: "m", attempts })).toEqual([]);
    }
    const [r] = await runCloseReview({ ctx, llm, model: "m", attempts });
    expect(r!.review.note).toBe("llm_failed");
  });

  it("treats a truncated reply as a failure and retries it, not as LESSON: NONE", async () => {
    const lessons = await seed([], [perf("ddd")]);
    const ctx = makeCtx({ repos: { lessons } });
    const replies = [
      { text: "WHAT", finish_reason: "length" },
      { text: "WHAT: a\nWHY: b\nLESSON: AVOID x\nMATCH: 15m.spike > 25 AND 15m.at_local_top = YES", finish_reason: "stop" },
    ];
    const llm: LLMClient = {
      chat: async () => ({ ...replies.shift()!, tool_calls: [], model: "m" }),
    };
    const attempts = new Map<string, number>();
    expect(await runCloseReview({ ctx, llm, model: "m", attempts })).toEqual([]);
    expect(attempts.get("ddd")).toBe(1);
    const [r] = await runCloseReview({ ctx, llm, model: "m", attempts });
    expect(r!.review).toMatchObject({ what: "a", why: "b", note: null });
    expect(r!.review.lesson_rule).toContain("AVOID x");
  });

  it("backfill fills empty LOSS reviews with a lesson and never re-scores cited lessons", async () => {
    const empty = (outcome: "win" | "loss") => ({
      reviewed_at: minsAgo(60),
      outcome,
      net_usd: -2,
      what: null,
      why: null,
      lesson_id: null,
      lesson_rule: null,
      lessons_applied: [{ id: "l-cited", rule: "PREFER sideways volume" }],
      note: "llm_none",
    });
    const cited: Lesson = {
      id: "l-cited",
      rule: "PREFER sideways volume",
      tags: [],
      created_at: minsAgo(500),
      stats: { applied: 4, wins: 2, losses: 2 },
    } as Lesson;
    const lessons = await seed(
      [cited],
      [
        perf("los", { review: empty("loss") }),
        perf("win", { pnl_pct: 5, review: empty("win"), entry_technicals: calm }),
        perf("ok", { review: { ...empty("loss"), what: "done" } }),
      ],
    );
    const llm = createFakeLLM({
      script: [{ kind: "assistant", text: "WHAT: dumped\nWHY: entered at top\nLESSON: AVOID entries at_local_top=YES\nMATCH: 15m.at_local_top = YES AND 15m.spike > 20" }],
    });
    const results = await backfillCloseReviews({ lessons, llm, model: "m", clock: { now: () => NOW } });

    expect(results.map((r) => [r.position, r.status])).toEqual([["los", "lesson"]]);
    const file = (await lessons.load()) as { ok: true; value: { lessons: Lesson[]; performance: PerformanceRecord[] } };
    const auto = file.value.lessons.find((l) => l.sourceType === "close-review")!;
    expect(auto.rule).toContain("AVOID entries at_local_top=YES");
    expect(auto.tags).toContain("backfill");
    expect(file.value.lessons.find((l) => l.id === "l-cited")!.stats).toMatchObject({ applied: 4, wins: 2, losses: 2 });
    const review = file.value.performance.find((p) => p.position === "los")!.review!;
    expect(review).toMatchObject({ what: "dumped", why: "entered at top", lesson_id: auto.id, note: null, reviewed_at: minsAgo(60) });
    // Win left untouched without --include-wins; a second run finds nothing.
    expect(file.value.performance.find((p) => p.position === "win")!.review!.what).toBeNull();
    expect(await backfillCloseReviews({ lessons, llm, model: "m", clock: { now: () => NOW } })).toEqual([]);
  });

  it("backfill leaves a record empty when the LLM keeps truncating", async () => {
    const lessons = await seed([], [
      perf("t", { review: { reviewed_at: minsAgo(60), outcome: "loss", lessons_applied: [], note: "llm_none" } }),
    ]);
    const llm: LLMClient = { chat: async () => ({ text: "WHAT", finish_reason: "length", tool_calls: [], model: "m" }) };
    const [r] = await backfillCloseReviews({ lessons, llm, model: "m", clock: { now: () => NOW } });
    expect(r!.status).toBe("failed");
    expect(pickBackfillable(((await lessons.load()) as { ok: true; value: { performance: PerformanceRecord[] } }).value.performance)).toHaveLength(1);
  });

  it("rejects a MATCH that also catches a past winner, then accepts the narrowed one", async () => {
    // The past winner spiked too, but from a much higher fee_tvl_ratio.
    const winner = perf("w1", { pnl_pct: 6, fee_tvl_ratio: 2.5, closed_at: minsAgo(3000), review: { reviewed_at: minsAgo(2900), outcome: "win", lessons_applied: [] } });
    const lessons = await seed([], [winner, perf("eee")]);
    const ctx = makeCtx({ repos: { lessons } });
    const llm = createFakeLLM({
      script: [
        { kind: "assistant", text: REPLY },
        { kind: "assistant", text: "WHAT: a\nWHY: b\nLESSON: AVOID spikes at top with thin fees\nMATCH: 15m.spike > 25 AND 15m.at_local_top = YES AND fee_tvl_ratio < 1" },
      ],
    });
    const [r] = await runCloseReview({ ctx, llm, model: "m" });

    // The feedback turn named the winner the broad MATCH would have blocked.
    const feedback = llm.requests()[1]!.messages.at(-1)!.content as string;
    expect(feedback).toContain("too broad");
    expect(feedback).toContain("W1-SOL +6.0%");
    // The first prompt already listed it as an opposite-outcome trade.
    expect(llm.requests()[0]!.messages[1]!.content).toContain("OPPOSITE-OUTCOME TRADES");
    expect(r!.review.lesson_rule).toContain("fee_tvl_ratio < 1 — history 0W/1L");
  });

  it("drops the lesson when the MATCH stays too broad, keeping WHAT/WHY", async () => {
    const winner = perf("w2", { pnl_pct: 6, closed_at: minsAgo(3000), review: { reviewed_at: minsAgo(2900), outcome: "win", lessons_applied: [] } });
    const lessons = await seed([], [winner, perf("fff")]);
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ repos: { lessons }, notifier });
    const llm = createFakeLLM({ script: [{ kind: "assistant", text: REPLY }, { kind: "assistant", text: REPLY }, { kind: "assistant", text: REPLY }] });
    const [r] = await runCloseReview({ ctx, llm, model: "m" });

    expect(llm.callCount()).toBe(1 + CLOSE_REVIEW_MAX_REFINES);
    expect(r!.review).toMatchObject({ lesson_id: null, note: "rule_too_broad", what: "Price fell 12% below the range within 40 minutes." });
    expect(String(r!.review.rejected_reason)).toContain("1W/1L");
    expect((await lessons.listLessons()).length).toBe(0);
  });

  it("backfill --redo replaces an earlier unpinned auto lesson with the backtested one", async () => {
    const old: Lesson = { id: "l-close-old", rule: "[auto LOSS] AVOID fee_tvl_ratio < 1", tags: ["auto"], sourceType: "close-review", pinned: false } as Lesson;
    const lessons = await seed(
      [old],
      [
        perf("red", {
          review: { reviewed_at: minsAgo(60), outcome: "loss", what: "x", why: "y", lesson_id: "l-close-old", lesson_rule: old.rule, lessons_applied: [], note: null },
        }),
      ],
    );
    const llm = createFakeLLM({ script: [{ kind: "assistant", text: REPLY }] });
    const [r] = await backfillCloseReviews({ lessons, llm, model: "m", clock: { now: () => NOW }, redo: new Set(["red"]) });

    expect(r).toMatchObject({ status: "lesson", replaced_lesson: "l-close-old" });
    const all = await lessons.listLessons();
    expect(all.map((l) => l.id)).not.toContain("l-close-old");
    expect(all).toHaveLength(1);
    expect(all[0]!.match).toBe("15m.spike > 25 AND 15m.at_local_top = YES");
  });

  it("picks the review model per close via modelFor and records it", async () => {
    const lessons = await seed([], [perf("big", { pnl_pct: -25 })]);
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ repos: { lessons }, notifier });
    const llm = createFakeLLM({ script: [{ kind: "assistant", text: REPLY }] });
    const seen: number[] = [];
    const [r] = await runCloseReview({
      ctx,
      llm,
      model: "fallback",
      modelFor: (pnl) => {
        seen.push(pnl);
        return pnl <= -10 ? "pricey" : "cheap";
      },
    });
    expect(seen).toEqual([-25]);
    expect(llm.requests()[0]!.model).toBe("pricey");
    expect(r!.review.model).toBe("pricey");
  });

  it("skips follow mirrors and does nothing when disabled", async () => {
    const lessons = await seed([], [perf("mir")]);
    const follow = memFollowRepo({
      mirrored: [{ position: "mir", pool: "pool-mir", source_wallet: "w", opened_at: minsAgo(90) } as never],
    });
    const ctx = makeCtx({ repos: { lessons, follow } });
    const llm = createFakeLLM({ script: [] });
    expect(await runCloseReview({ ctx, llm, model: "m" })).toEqual([]);

    const lessons2 = await seed([], [perf("x")]);
    const off = makeCtx({
      repos: { lessons: lessons2 },
      config: { ...makeCtx().config, management: { ...mgmt, closeReviewEnabled: false } } as AppConfig,
    });
    expect(await runCloseReview({ ctx: off, llm, model: "m" })).toEqual([]);
    expect(llm.callCount()).toBe(0);
  });
});
