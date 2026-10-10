import type { AppConfig } from "../schemas/config.js";
import type { DecisionEntry } from "../schemas/decision.js";
import type { Lesson, PerformanceRecord } from "../schemas/lesson.js";
import type { StrategyEntry } from "../schemas/strategy.js";
import type { PositionsSnapshot } from "../schemas/chain.js";
import type { WalletBalance } from "../schemas/chain.js";
import { formatLessonsBlock, selectPromptLessons } from "./lessons.js";

export type AgentRole = "SCREENER" | "MANAGER" | "GENERAL";

export interface PromptContext {
  role: AgentRole;
  wallet: WalletBalance;
  positions: PositionsSnapshot;
  config: AppConfig;
  activeStrategy?: StrategyEntry | null | undefined;
  recentDecisions?: DecisionEntry[] | undefined;
  recentPerformance?: PerformanceRecord[] | undefined;
  lessons?: Lesson[] | undefined;
}

const HEADER = "You are Meridian, an autonomous Meteora DLMM liquidity provider on Solana.";

function summarizeWallet(w: WalletBalance): string {
  return `Wallet: ${w.sol.toFixed(4)} SOL ($${w.sol_usd.toFixed(2)}) @ SOL=$${w.sol_price}`;
}

function summarizePositions(p: PositionsSnapshot, maxPositions: number): string {
  if (p.positions.length === 0) return `Open positions: 0 / ${maxPositions}`;
  const lines = p.positions.slice(0, 10).map((pos, i) => {
    const pnl = pos.pnl_pct == null ? "?" : `${pos.pnl_pct.toFixed(2)}%`;
    const fees = pos.unclaimed_fees_usd.toFixed(2);
    return `  [${i + 1}] ${pos.pair}  pnl:${pnl}  fees:$${fees}  in_range:${pos.in_range}  age:${pos.age_minutes ?? "?"}m`;
  });
  return `Open positions: ${p.total_positions} / ${maxPositions}\n${lines.join("\n")}`;
}

function summarizeStrategy(s: StrategyEntry): string {
  return `Active strategy: ${s.name} (${s.id}) — ${s.lp_strategy}. best_for: ${s.best_for ?? "n/a"}`;
}

function summarizeDecisions(ds: DecisionEntry[]): string {
  if (!ds.length) return "No recent structured decisions.";
  const lines = ds.slice(0, 5).map((d, i) => {
    const label = `${d.type.toUpperCase()} ${d.pool_name ?? d.pool ?? "?"}`;
    const reason = d.reason ? ` — ${d.reason}` : "";
    return `  ${i + 1}. [${d.actor}] ${label}${reason}`;
  });
  return `Recent decisions:\n${lines.join("\n")}`;
}

function summarizePerformance(records: PerformanceRecord[]): string {
  if (!records.length) return "No performance history yet.";
  const wins = records.filter((r) => r.pnl_pct > 0).length;
  const avg = records.reduce((s, r) => s + r.pnl_pct, 0) / records.length;
  return `Performance (${records.length}): win_rate=${((wins / records.length) * 100).toFixed(0)}% avg_pnl=${avg.toFixed(2)}%`;
}

function summarizeLessons(lessons: Lesson[]): string {
  if (!lessons.length) return "";
  return formatLessonsBlock(selectPromptLessons(lessons));
}

function roleInstructions(role: AgentRole): string {
  switch (role) {
    case "SCREENER":
      return [
        "ROLE: SCREENER.",
        "Decide whether to open a new position. Prefer to call `deploy_position` only when a candidate meets the active strategy AND has confirmed activity/organic signals.",
        "No hallucination — do not claim to have deployed unless `deploy_position` was called and returned success=true.",
        "bins_below FLOOR: 35. Never call deploy_position with bins_below < 35.",
        "Strategy: spot or bid_ask only. curve is FORBIDDEN (user mandate 2026-09-25) — never deploy curve, whatever an older lesson says.",
        "When you call deploy_position, always fill `reason` (1-2 sentences: why this pool and this strategy, citing the numbers) and `lessons_applied` (the [ids] of the LESSONS that shaped this decision; [] if none did). These are recorded and scored after the position closes.",
      ].join("\n");
    case "MANAGER":
      return [
        "ROLE: MANAGER.",
        "Apply the deterministic close rules mechanically. For positions with an `instruction` set, evaluate the condition and act immediately if met (BIAS TO HOLD does NOT override an instruction condition).",
        "Do NOT re-evaluate a position that already has a queued action — execute it.",
      ].join("\n");
    case "GENERAL":
      return [
        "ROLE: GENERAL.",
        "Interactive assistant. Use tools to answer questions about wallet, positions, memory, and decisions.",
      ].join("\n");
  }
}

/**
 * Assemble the full system prompt. Kept pure — every input arrives via the ctx argument.
 * All summaries live in this file; no imports of stateful modules.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const blocks: string[] = [
    HEADER,
    roleInstructions(ctx.role),
    "── STATE ──",
    summarizeWallet(ctx.wallet),
    summarizePositions(ctx.positions, ctx.config.risk.maxPositions),
  ];
  if (ctx.activeStrategy) blocks.push("── STRATEGY ──", summarizeStrategy(ctx.activeStrategy));
  if (ctx.recentDecisions?.length) blocks.push("── DECISIONS ──", summarizeDecisions(ctx.recentDecisions));
  if (ctx.recentPerformance?.length) blocks.push("── PERFORMANCE ──", summarizePerformance(ctx.recentPerformance));
  const lessonsText = ctx.lessons ? summarizeLessons(ctx.lessons) : "";
  if (lessonsText) blocks.push("── LESSONS ──", lessonsText);
  return blocks.join("\n\n");
}
