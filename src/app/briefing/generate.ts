import type { Lesson, PerformanceRecord } from "../../domain/schemas/lesson.js";
import type { TrackedPosition } from "../../domain/schemas/position.js";

export interface BriefingInput {
  positions: TrackedPosition[];
  performance: PerformanceRecord[];
  lessons: Lesson[];
  now: Date;
  lookbackHours?: number;
}

export interface BriefingCounts {
  opened_24h: number;
  closed_24h: number;
  net_pnl_usd_24h: number;
  fees_usd_24h: number;
  win_rate_pct_24h: number | null;
  open_positions: number;
  new_lessons_24h: number;
}

export interface BriefingSummary {
  html: string;
  plain: string;
  counts: BriefingCounts;
}

function parseIsoOrNull(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pure — builds the daily briefing summary (HTML + plain-text + counts) from repo data.
 *
 * Mirrors briefing.js. The generator is pure so the same data can drive Telegram
 * (HTML parse_mode), console output, and future channels (email/Discord).
 */
export function generateBriefing(input: BriefingInput): BriefingSummary {
  const lookbackMs = (input.lookbackHours ?? 24) * 3_600_000;
  const cutoffMs = input.now.getTime() - lookbackMs;

  const openedLast: TrackedPosition[] = [];
  const closedLast: TrackedPosition[] = [];
  const openNow: TrackedPosition[] = [];
  for (const p of input.positions) {
    if (p.closed) {
      const closedMs = parseIsoOrNull(p.closed_at);
      if (closedMs != null && closedMs > cutoffMs) closedLast.push(p);
    } else {
      openNow.push(p);
    }
    const deployedMs = parseIsoOrNull(p.deployed_at);
    if (deployedMs != null && deployedMs > cutoffMs) openedLast.push(p);
  }

  const perfLast = input.performance.filter((r) => {
    const ms = parseIsoOrNull(r.recorded_at);
    return ms != null && ms > cutoffMs;
  });
  // `pnl_usd` is price movement only; net = pnl_usd + fees (close-pnl.ts semantics), the
  // figure Meteora and the dashboard History show. A fee-earning position is routinely
  // negative on price alone, so both the net line and the win rate must include fees.
  const netOf = (r: (typeof perfLast)[number]) => toNum(r.pnl_usd) + toNum(r.fees_earned_usd);
  const netPnlUsd = perfLast.reduce((s, r) => s + netOf(r), 0);
  const feesUsd = perfLast.reduce((s, r) => s + toNum(r.fees_earned_usd), 0);
  const winRate =
    perfLast.length > 0
      ? Math.round((perfLast.filter((r) => netOf(r) > 0).length / perfLast.length) * 100)
      : null;

  const newLessons = input.lessons.filter((l) => {
    const ms = parseIsoOrNull(l.created_at);
    return ms != null && ms > cutoffMs;
  });

  const counts: BriefingCounts = {
    opened_24h: openedLast.length,
    closed_24h: closedLast.length,
    net_pnl_usd_24h: Math.round(netPnlUsd * 100) / 100,
    fees_usd_24h: Math.round(feesUsd * 100) / 100,
    win_rate_pct_24h: winRate,
    open_positions: openNow.length,
    new_lessons_24h: newLessons.length,
  };

  const pnlPrefix = counts.net_pnl_usd_24h >= 0 ? "+" : "";
  const winStr = winRate == null ? "N/A" : `${winRate}%`;

  const lessonsBlock =
    newLessons.length > 0
      ? newLessons.slice(0, 5).map((l) => `• ${l.rule}`).join("\n")
      : "• No new lessons recorded.";

  const plainLines = [
    `☀️ Morning Briefing (Last ${input.lookbackHours ?? 24}h)`,
    "─────────────────────────────────",
    "Activity:",
    `  📥 Positions opened: ${counts.opened_24h}`,
    `  📤 Positions closed: ${counts.closed_24h}`,
    "",
    "Performance:",
    `  💰 Net PnL: ${pnlPrefix}$${counts.net_pnl_usd_24h.toFixed(2)}`,
    `  💎 Fees earned: $${counts.fees_usd_24h.toFixed(2)}`,
    `  📈 Win rate: ${winStr}`,
    "",
    "Lessons:",
    lessonsBlock,
    "",
    "Current portfolio:",
    `  📂 Open positions: ${counts.open_positions}`,
    "─────────────────────────────────",
  ];

  const htmlLines = [
    `☀️ <b>Morning Briefing</b> (Last ${input.lookbackHours ?? 24}h)`,
    "─────────────────────────────────",
    "<b>Activity:</b>",
    `📥 Positions opened: ${counts.opened_24h}`,
    `📤 Positions closed: ${counts.closed_24h}`,
    "",
    "<b>Performance:</b>",
    `💰 Net PnL: ${pnlPrefix}$${counts.net_pnl_usd_24h.toFixed(2)}`,
    `💎 Fees earned: $${counts.fees_usd_24h.toFixed(2)}`,
    `📈 Win rate: ${winStr}`,
    "",
    "<b>Lessons:</b>",
    lessonsBlock,
    "",
    "<b>Current portfolio:</b>",
    `📂 Open positions: ${counts.open_positions}`,
    "─────────────────────────────────",
  ];

  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
    counts,
  };
}
