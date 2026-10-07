import { describe, it, expect } from "vitest";
import { groupByDay, monthGrid, summarizeMonth, dayKey, dayPct, closeNetUsd } from "./pnl-calendar";
import type { PerformanceEntry } from "./types";

// Build ISO strings from LOCAL times so the tests pass in any timezone.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

describe("pnl-calendar", () => {
  it("net = pnl_usd + fees, null when pnl missing", () => {
    expect(closeNetUsd({ pnl_usd: -10, fees_earned_usd: 4 })).toBe(-6);
    expect(closeNetUsd({ pnl_usd: 5 })).toBe(5);
    expect(closeNetUsd({ fees_earned_usd: 3 })).toBeNull();
  });

  it("groups closes by local day and sums net, fees, wins, losses", () => {
    const perf: PerformanceEntry[] = [
      { closed_at: at(2026, 9, 7, 1), pnl_usd: -10, fees_earned_usd: 4, initial_value_usd: 30 },
      { closed_at: at(2026, 9, 7, 22), pnl_usd: 2, fees_earned_usd: 1, initial_value_usd: 30 },
      { recorded_at: at(2026, 9, 8), pnl_usd: 1, fees_earned_usd: 0 },
      { pnl_usd: 99 }, // no close time → dropped
    ];
    const days = groupByDay(perf);
    expect([...days.keys()].sort()).toEqual(["2026-10-07", "2026-10-08"]);
    const d7 = days.get("2026-10-07")!;
    expect(d7.netUsd).toBeCloseTo(-3);
    expect(d7.feesUsd).toBeCloseTo(5);
    expect(d7.wins).toBe(1);
    expect(d7.losses).toBe(1);
    expect(dayPct(d7)).toBeCloseTo(-5);
    expect(d7.closes[0].closeTs).toBeGreaterThan(d7.closes[1].closeTs); // newest first
  });

  it("builds a Monday-first grid padded to whole weeks", () => {
    // Oct 2026 starts on a Thursday → 3 leading blanks.
    const cells = monthGrid(2026, 9);
    expect(cells.length % 7).toBe(0);
    expect(cells.slice(0, 3)).toEqual([null, null, null]);
    expect(dayKey(cells[3]!)).toBe("2026-10-01");
    expect(cells.filter(Boolean)).toHaveLength(31);
  });

  it("summarizes only the requested month", () => {
    const days = groupByDay([
      { closed_at: at(2026, 9, 1), pnl_usd: 5 },
      { closed_at: at(2026, 9, 2), pnl_usd: -8 },
      { closed_at: at(2026, 9, 3), pnl_usd: 2 },
      { closed_at: at(2026, 8, 30), pnl_usd: 100 },
    ]);
    const s = summarizeMonth(days, 2026, 9);
    expect(s.netUsd).toBeCloseTo(-1);
    expect(s.closes).toBe(3);
    expect(s.greenDays).toBe(2);
    expect(s.redDays).toBe(1);
    expect(s.best?.key).toBe("2026-10-01");
    expect(s.worst?.key).toBe("2026-10-02");
  });
});
