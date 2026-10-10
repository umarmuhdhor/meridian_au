import { describe, it, expect } from "vitest";
import { learningCurve, type CurveInput } from "./learning-curve";

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, n)).toISOString();

describe("learningCurve", () => {
  const rows: CurveInput[] = [
    { pool_name: "A", pnl_pct: 2, pnl_usd: 1, fees_earned_usd: 0.5, closed_at: at(1) },
    { pool_name: "B", pnl_pct: -5, pnl_usd: -3, fees_earned_usd: 1, closed_at: at(2) },
    { pool_name: "C", pnl_pct: 3, closed_at: at(3), review: { outcome: "win", net_usd: 2, lesson_id: "l1" } },
    { pool_name: "D", pnl_pct: -10, closed_at: at(4), review: { outcome: "loss", net_usd: -4, lesson_id: "l2" } },
    { pool_name: "E", pnl_pct: 1, closed_at: at(5), review: { outcome: "win", net_usd: 1, lesson_id: null } },
  ];

  it("builds running totals in close order", () => {
    const c = learningCurve([...rows].reverse(), 2);
    expect(c.points.map((p) => p.coin)).toEqual(["A", "B", "C", "D", "E"]);
    expect(c.points.map((p) => p.cumNet)).toEqual([1.5, -0.5, 1.5, -2.5, -1.5]);
    expect(c.points.map((p) => p.winRate)).toEqual([100, 50, 50, 50, 50]);
    expect(c.points.map((p) => [p.rulesRepeat, p.rulesAvoid])).toEqual([[0, 0], [0, 0], [1, 0], [1, 1], [1, 1]]);
    expect(c.points.map((p) => p.learned)).toEqual([null, null, "ULANGI", "HINDARI", null]);
  });

  it("splits before/after at the first reviewed close", () => {
    const c = learningCurve(rows);
    expect(c.startIndex).toBe(3);
    expect(c.before).toEqual({ n: 2, winRate: 50, avgNet: -0.25, avgWin: 1.5, avgLoss: -2 });
    expect(c.after?.n).toBe(3);
    expect(c.after?.avgLoss).toBe(-4);
  });

  it("has no 'after' phase before any review", () => {
    const c = learningCurve(rows.slice(0, 2));
    expect(c.startIndex).toBeNull();
    expect(c.before?.n).toBe(2);
    expect(c.after).toBeNull();
  });
});
