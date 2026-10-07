import type { PerformanceEntry } from "./types";

// Daily realised PnL for the calendar page, built from lessons.json performance[].
// Each closed position lands on the LOCAL calendar day of its close. Net per close =
// pnl_usd (exit − entry, fees excluded) + fees_earned_usd — the same "net" that
// History and the close review use, and what Meteora's UI shows.

export interface CalendarClose {
  perf: PerformanceEntry;
  closeTs: number;
  netUsd: number | null;
}

export interface DayPnl {
  /** Local date key "YYYY-MM-DD". */
  key: string;
  closes: CalendarClose[];
  netUsd: number;
  feesUsd: number;
  /** Sum of entry value of the day's closes — denominator for the day %. */
  entryUsd: number;
  wins: number;
  losses: number;
}

export interface MonthSummary {
  netUsd: number;
  feesUsd: number;
  closes: number;
  wins: number;
  losses: number;
  greenDays: number;
  redDays: number;
  best: DayPnl | null;
  worst: DayPnl | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthKey(year: number, month: number): string {
  return `${year}-${pad(month + 1)}`;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function closeTimestamp(p: PerformanceEntry): number | null {
  const raw = p.closed_at ?? p.recorded_at ?? p.ts;
  if (raw == null) return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

export function closeNetUsd(p: PerformanceEntry): number | null {
  const pnl = num(p.pnl_usd);
  if (pnl == null) return null;
  return pnl + (num(p.fees_earned_usd) ?? 0);
}

/** Group closes by local day. Records without a parseable close time are dropped. */
export function groupByDay(performance: PerformanceEntry[]): Map<string, DayPnl> {
  const days = new Map<string, DayPnl>();
  for (const perf of performance) {
    const closeTs = closeTimestamp(perf);
    if (closeTs == null) continue;
    const key = dayKey(new Date(closeTs));
    let day = days.get(key);
    if (!day) {
      day = { key, closes: [], netUsd: 0, feesUsd: 0, entryUsd: 0, wins: 0, losses: 0 };
      days.set(key, day);
    }
    const netUsd = closeNetUsd(perf);
    day.closes.push({ perf, closeTs, netUsd });
    if (netUsd != null) {
      day.netUsd += netUsd;
      if (netUsd > 0) day.wins++;
      else if (netUsd < 0) day.losses++;
    }
    day.feesUsd += num(perf.fees_earned_usd) ?? 0;
    day.entryUsd += num(perf.initial_value_usd) ?? 0;
  }
  for (const day of days.values()) day.closes.sort((a, b) => b.closeTs - a.closeTs);
  return days;
}

export function dayPct(day: DayPnl): number | null {
  return day.entryUsd > 0 ? (day.netUsd / day.entryUsd) * 100 : null;
}

/** Monday-first grid of the month: leading/trailing nulls pad to whole weeks. */
export function monthGrid(year: number, month: number): (Date | null)[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Mon=0 … Sun=6
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function summarizeMonth(days: Map<string, DayPnl>, year: number, month: number): MonthSummary {
  const prefix = `${monthKey(year, month)}-`;
  const s: MonthSummary = {
    netUsd: 0, feesUsd: 0, closes: 0, wins: 0, losses: 0, greenDays: 0, redDays: 0, best: null, worst: null,
  };
  for (const day of days.values()) {
    if (!day.key.startsWith(prefix)) continue;
    s.netUsd += day.netUsd;
    s.feesUsd += day.feesUsd;
    s.closes += day.closes.length;
    s.wins += day.wins;
    s.losses += day.losses;
    if (day.netUsd > 0) s.greenDays++;
    else if (day.netUsd < 0) s.redDays++;
    if (day.netUsd > 0 && (!s.best || day.netUsd > s.best.netUsd)) s.best = day;
    if (day.netUsd < 0 && (!s.worst || day.netUsd < s.worst.netUsd)) s.worst = day;
  }
  return s;
}

/** Largest |net| across the month's days — scales the cell tint intensity. */
export function maxAbsNet(days: Map<string, DayPnl>, year: number, month: number): number {
  const prefix = `${monthKey(year, month)}-`;
  let max = 0;
  for (const day of days.values()) {
    if (day.key.startsWith(prefix)) max = Math.max(max, Math.abs(day.netUsd));
  }
  return max;
}
