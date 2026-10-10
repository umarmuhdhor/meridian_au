import { describe, expect, it } from "vitest";
import type { PerformanceRecord } from "../../src/domain/schemas/lesson.js";
import type { TechnicalsSummary } from "../../src/domain/schemas/kline.js";
import {
  acceptBacktest,
  candidateAsRecord,
  lessonsForCandidate,
  backtestMatch,
  describeEntry,
  matchesRecord,
  parseMatch,
  similarOpposite,
} from "../../src/domain/rules/lesson-match.js";

const t = (timeframe: string, over: Partial<TechnicalsSummary> = {}) =>
  ({ timeframe, candles: 100, trend: "UP", spike_pct: 10, from_window_high_pct: -5, atr_pct: 8, at_local_top: false, ...over }) as TechnicalsSummary;

const rec = (pool: string, pnl_pct: number, over: Partial<PerformanceRecord> = {}): PerformanceRecord =>
  ({ position: pool, pool_name: pool, pnl_pct, close_reason: "x", fee_tvl_ratio: 0.5, entry_technicals: [t("1h"), t("15m")], ...over }) as PerformanceRecord;

describe("parseMatch", () => {
  it("parses AND-joined conditions in screener vocabulary", () => {
    const r = parseMatch("1h.from_high < -32% AND 1h.trend = down AND fee_tvl_ratio <= 0.3");
    expect(r).toEqual({
      ok: true,
      value: [
        { field: "1h.from_high", op: "<", value: -32 },
        { field: "1h.trend", op: "=", value: "DOWN" },
        { field: "fee_tvl_ratio", op: "<=", value: 0.3 },
      ],
    });
  });

  it("rejects single-factor, OR, unknown fields and ordered text comparisons", () => {
    expect(parseMatch("fee_tvl_ratio < 1").ok).toBe(false);
    expect(parseMatch("1h.trend = DOWN OR fee_tvl_ratio < 1").ok).toBe(false);
    expect(parseMatch("1h.rsi < 30 AND fee_tvl_ratio < 1").ok).toBe(false);
    expect(parseMatch("1h.trend < DOWN AND fee_tvl_ratio < 1").ok).toBe(false);
  });
});

describe("matching + backtest", () => {
  const history = [
    rec("LOSS-A", -20, { entry_technicals: [t("1h", { trend: "DOWN", from_window_high_pct: -35 })] }),
    rec("WIN-B", 8, { fee_tvl_ratio: 2, entry_technicals: [t("1h", { trend: "DOWN", from_window_high_pct: -40 })] }),
    rec("WIN-C", 3),
  ];

  it("a broad rule catches the winner; the narrowed one does not", () => {
    const broad = parseMatch("1h.trend = DOWN AND 1h.from_high < -30");
    const narrow = parseMatch("1h.trend = DOWN AND 1h.from_high < -30 AND fee_tvl_ratio < 1");
    if (!broad.ok || !narrow.ok) throw new Error("parse");
    const b = backtestMatch(broad.value, history);
    expect(b).toMatchObject({ wins: 1, losses: 1, winners: ["WIN-B +8.0%"] });
    expect(acceptBacktest("loss", b)).toBe(false);
    const n = backtestMatch(narrow.value, history);
    expect(n).toMatchObject({ wins: 0, losses: 1 });
    expect(acceptBacktest("loss", n)).toBe(true);
  });

  it("missing data never satisfies a condition", () => {
    const m = parseMatch("4h.trend = DOWN AND fee_tvl_ratio < 1");
    if (!m.ok) throw new Error("parse");
    expect(matchesRecord(m.value, history[0]!)).toBe(false);
  });

  it("tolerates one opposite hit only when the rule catches 3+ of its own kind", () => {
    expect(acceptBacktest("loss", { wins: 1, losses: 3, winners: [], losers: [] })).toBe(true);
    expect(acceptBacktest("loss", { wins: 1, losses: 2, winners: [], losers: [] })).toBe(false);
    expect(acceptBacktest("win", { wins: 2, losses: 0, winners: [], losers: [] })).toBe(true);
  });
});

describe("describeEntry / similarOpposite", () => {
  it("renders the entry in MATCH vocabulary and finds lookalike winners for a loss", () => {
    const loss = rec("L", -15, { entry_technicals: [t("1h", { trend: "DOWN", from_window_high_pct: -34.8 })] });
    expect(describeEntry(loss)).toContain("1h.trend=DOWN");
    expect(describeEntry(loss)).toContain("1h.from_high=-34.8");
    const near = rec("NEAR", 5, { entry_technicals: [t("1h", { trend: "DOWN", from_window_high_pct: -33 })] });
    const far = rec("FAR", 5, { fee_tvl_ratio: 5, entry_technicals: [t("1h", { trend: "UP", from_window_high_pct: -1 })] });
    const otherLoss = rec("OL", -3);
    expect(similarOpposite(loss, [far, otherLoss, near], 2).map((p) => p.pool_name)).toEqual(["NEAR", "FAR"]);
  });
});

describe("lessonsForCandidate", () => {
  const lesson = (id: string, match: string) => ({ id, rule: `rule ${id}`, tags: [], pinned: false, match }) as never;
  const cand = candidateAsRecord({ fee_tvl_ratio: 0.2, mcap: 500_000, technicals: [t("1h", { trend: "DOWN", from_window_high_pct: -40 })] });

  it("lists only lessons whose full condition holds for the candidate", () => {
    const hits = lessonsForCandidate(
      [
        lesson("hit", "1h.trend = DOWN AND fee_tvl_ratio < 0.3"),
        lesson("miss", "1h.trend = DOWN AND fee_tvl_ratio < 0.1"),
        lesson("nodata", "15m.trend = DOWN AND mcap < 1000000"),
      ],
      cand,
    );
    expect(hits.map((h) => h.lesson.id)).toEqual(["hit"]);
  });

  it("defers a strategy condition to the decision instead of evaluating it", () => {
    const [h] = lessonsForCandidate([lesson("s", "strategy = spot AND 1h.from_high < -30 AND mcap < 1000000")], cand);
    expect(h).toMatchObject({ strategy: "spot" });
  });
});
