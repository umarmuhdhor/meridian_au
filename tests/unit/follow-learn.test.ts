import { describe, expect, it } from "vitest";
import type { Lesson, PerformanceRecord } from "../../src/domain/schemas/lesson.js";
import type { TechnicalsSummary } from "../../src/domain/schemas/kline.js";
import type { MirroredPosition } from "../../src/domain/schemas/follow-wallet.js";
import { learnFromMirror } from "../../src/app/follow/learn.js";
import { createFakeLLM } from "../../src/adapters/llm/fake.js";
import { memLessonRepo } from "./tool-context.js";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;

const tech = (over: Partial<TechnicalsSummary>): TechnicalsSummary[] => [
  { timeframe: "1h", candles: 100, trend: "DOWN", spike_pct: 80, from_window_high_pct: -45, atr_pct: 20, vol_spike: 2, ...over } as TechnicalsSummary,
];

const perf = (position: string, pnl_pct: number, t: TechnicalsSummary[]): PerformanceRecord =>
  ({ position, pool_name: `${position}-SOL`, pnl_pct, close_reason: "x", entry_technicals: t }) as PerformanceRecord;

const mirror = (position: string): MirroredPosition =>
  ({ position, pool: `pool-${position}`, pool_name: `${position}-SOL`, source_wallet: "WaLLeT1234567", source_label: "a", entry_technicals: tech({}) }) as MirroredPosition;

const reply = (match: string) =>
  `ENTRY: bought a deep retrace\nEXIT: left on the bounce\nLESSON: AVOID deep retrace with high spike in a downtrend\nMATCH: ${match}`;

async function setup(records: PerformanceRecord[], lessons: Lesson[] = []) {
  const repo = memLessonRepo();
  for (const l of lessons) await repo.addLesson(l);
  for (const r of records) await repo.appendPerformance(r);
  return repo;
}

describe("learnFromMirror", () => {
  it("stores a follow lesson only once its MATCH passes the backtest", async () => {
    // A past WINNER shares the deep retrace but spiked far less.
    const lessons = await setup([perf("win", 5, tech({ spike_pct: 20 })), perf("PARA", -29.6, tech({}))]);
    const llm = createFakeLLM({
      script: [
        { kind: "assistant", text: reply("1h.from_high < -40 AND 1h.trend = DOWN") },
        { kind: "assistant", text: reply("1h.from_high < -40 AND 1h.trend = DOWN AND 1h.spike > 50") },
      ],
    });
    const out = await learnFromMirror({ lessons, logger, clock: { now: () => NOW }, llm, model: "m" }, mirror("PARA"), -29.6);

    expect(llm.callCount()).toBe(2);
    expect(out.rule).toContain("[follow:a]");
    expect(out.rule).toContain("{applies ONLY when: 1h.from_high < -40 AND 1h.trend = DOWN AND 1h.spike > 50 — history 0W/1L}");
    const stored = (await lessons.listLessons()).find((l) => l.id === out.lessonId)!;
    expect(stored.match).toBe("1h.from_high < -40 AND 1h.trend = DOWN AND 1h.spike > 50");
  });

  it("drops a rule that stays too broad and retires the lesson it was replacing", async () => {
    const old = { id: "l-follow-old", rule: "[follow:a] PREFER deep retraces", tags: ["follow"], sourceType: "follow-retrospective", pinned: false } as Lesson;
    const lessons = await setup([perf("win", 5, tech({})), perf("PARA", -29.6, tech({}))], [old]);
    const broad = { kind: "assistant" as const, text: reply("1h.from_high < -40 AND 1h.trend = DOWN") };
    const llm = createFakeLLM({ script: [broad, broad, broad] });
    const out = await learnFromMirror({ lessons, logger, clock: { now: () => NOW }, llm, model: "m" }, mirror("PARA"), -29.6, {
      replaceLessonId: "l-follow-old",
    });

    expect(out.lessonId).toBeNull();
    expect(out.entry).toBe("bought a deep retrace");
    expect(out.rejected).toContain("too broad");
    expect(await lessons.listLessons()).toEqual([]);
  });
});
