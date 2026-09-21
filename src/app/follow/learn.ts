import type { AppContext } from "../tools/context.js";
import type { LLMClient } from "../../ports/llm-client.js";
import type { KlineTimeframe, TechnicalsSummary } from "../../domain/schemas/kline.js";
import type { MirroredPosition } from "../../domain/schemas/follow-wallet.js";
import { computeTechnicals, formatTechnicalsBlock } from "../../domain/format/technicals.js";

export const FOLLOW_TECHNICALS_TIMEFRAMES: readonly KlineTimeframe[] = ["15m", "1h"] as const;
const KLINE_LIMIT = 100;
const KLINE_TIMEOUT_MS = 3_500;
const LESSON_MAX_LEN = 500;

/**
 * Snapshot the pool's multi-timeframe technicals. Fail-open, exactly like the screening
 * and track-position enrichment: a dead GeckoTerminal must never block a mirror.
 */
export async function captureTechnicals(
  ctx: AppContext,
  poolAddress: string,
): Promise<TechnicalsSummary[] | null> {
  const withTimeout = <T,>(p: Promise<T>): Promise<T | null> =>
    Promise.race([
      p,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), KLINE_TIMEOUT_MS)),
    ]);

  try {
    const windowShort = ctx.config.screening.technicalsWindowShort;
    const windowMin = Math.max(3, Math.floor(ctx.config.screening.minTokenAgeHours ?? 3));
    return await Promise.all(
      FOLLOW_TECHNICALS_TIMEFRAMES.map(async (tf) => {
        const candles = await withTimeout(
          ctx.market.kline.getKline(poolAddress, tf, { limit: KLINE_LIMIT }),
        ).catch(() => null);
        return computeTechnicals(candles ?? [], tf, { windowShort, windowMin });
      }),
    );
  } catch {
    return null;
  }
}

export interface FollowRetrospectiveDeps {
  ctx: AppContext;
  llm?: LLMClient | undefined;
  model?: string | undefined;
}

const SYSTEM_PROMPT = [
  "You analyse a copy-traded Meteora DLMM position after the fact.",
  "Meridian mirrored a wallet it follows: it entered when that wallet entered and exited when that wallet exited.",
  "Meridian did NOT choose this pool and applied none of its own entry filters, so it has no thesis of its own to review.",
  "Your job is to infer, from the market structure captured at entry and at exit, WHY the followed wallet plausibly entered and WHY it plausibly exited.",
  "",
  "Answer in exactly three lines, no preamble, no markdown:",
  "ENTRY: <one sentence — what the wallet likely saw at entry>",
  "EXIT: <one sentence — what likely triggered their exit>",
  "LESSON: <one PREFER/AVOID rule, under 200 characters, for judging this wallet's future signals>",
  "",
  "Be concrete about the numbers you were given. If the evidence is too thin to infer a reason, say so plainly rather than inventing one.",
].join("\n");

function buildUserPrompt(record: MirroredPosition, ourPnlPct: number | null): string {
  const lines: string[] = [];
  lines.push(`Followed wallet: ${record.source_label || record.source_wallet}`);
  lines.push(`Pool: ${record.pool_name ?? record.pool}`);
  if (record.opened_at && record.closed_at) {
    const held = Math.round(
      (new Date(record.closed_at).getTime() - new Date(record.opened_at).getTime()) / 60_000,
    );
    if (Number.isFinite(held)) lines.push(`Held: ${held} minutes`);
  }
  if (record.source_lower_bin != null && record.source_upper_bin != null) {
    lines.push(
      `Their bin range: ${record.source_lower_bin} → ${record.source_upper_bin} (${record.source_upper_bin - record.source_lower_bin} bins)`,
    );
  }
  if (record.source_deposit_sol != null) {
    lines.push(`Their deposit: ${record.source_deposit_sol} SOL`);
  }
  if (record.source_pnl_pct != null) {
    lines.push(`Their PnL at exit: ${record.source_pnl_pct.toFixed(2)}%`);
  }
  if (record.amount_sol != null) lines.push(`Our mirrored size: ${record.amount_sol} SOL`);
  if (ourPnlPct != null) lines.push(`Our PnL at exit: ${ourPnlPct.toFixed(2)}%`);

  const entry = record.entry_technicals ? formatTechnicalsBlock(record.entry_technicals) : null;
  const exit = record.exit_technicals ? formatTechnicalsBlock(record.exit_technicals) : null;
  lines.push("");
  lines.push("MARKET STRUCTURE AT ENTRY:");
  lines.push(entry ?? "(unavailable)");
  lines.push("");
  lines.push("MARKET STRUCTURE AT EXIT:");
  lines.push(exit ?? "(unavailable)");
  return lines.join("\n");
}

export interface RetrospectiveOutcome {
  lessonId: string | null;
  entry: string | null;
  exit: string | null;
  rule: string | null;
}

const sanitize = (t: string): string =>
  t.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, LESSON_MAX_LEN);

/** Pull `ENTRY:` / `EXIT:` / `LESSON:` out of the model's reply. Tolerates extra prose. */
export function parseRetrospective(text: string): Omit<RetrospectiveOutcome, "lessonId"> {
  const grab = (label: string): string | null => {
    const m = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im").exec(text);
    return m?.[1] ? sanitize(m[1]) : null;
  };
  return { entry: grab("ENTRY"), exit: grab("EXIT"), rule: grab("LESSON") };
}

/**
 * Post-close retrospective for a mirrored position.
 *
 * Two layers, so the feature still learns something when the LLM is unavailable:
 *   - Always: the entry/exit technicals are persisted on the mirror record itself,
 *     which is the durable evidence a later analysis can mine.
 *   - When an LLM is wired: infer the wallet's entry and exit reasoning and persist it
 *     as a tagged lesson, so future prompts carry what this wallet's signals looked like.
 *
 * Never throws — a failed retrospective must not affect the close that already happened.
 */
export async function runFollowRetrospective(
  deps: FollowRetrospectiveDeps,
  record: MirroredPosition,
  ourPnlPct: number | null,
): Promise<RetrospectiveOutcome> {
  const { ctx, llm, model } = deps;
  const empty: RetrospectiveOutcome = { lessonId: null, entry: null, exit: null, rule: null };
  if (!llm || !model) return empty;

  let parsed: Omit<RetrospectiveOutcome, "lessonId">;
  try {
    const res = await llm.chat({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(record, ourPnlPct) },
      ],
      temperature: 0.2,
      max_tokens: 400,
    });
    if (!res.text) return empty;
    parsed = parseRetrospective(res.text);
  } catch (e) {
    ctx.logger.warn("follow-learn", "retrospective LLM call failed", {
      position: record.position.slice(0, 8),
      error: e instanceof Error ? e.message : String(e),
    });
    return empty;
  }

  if (!parsed.rule) return { ...parsed, lessonId: null };

  const now = ctx.clock.now();
  const id = `l-follow-${now.getTime()}`;
  const label = record.source_label || record.source_wallet.slice(0, 8);
  try {
    await ctx.repos.lessons.addLesson({
      id,
      rule: sanitize(`[follow:${label}] ${parsed.rule}`),
      tags: ["follow", `wallet:${record.source_wallet.slice(0, 8)}`],
      role: "SCREENER",
      pinned: false,
      sourceType: "follow-retrospective",
      created_at: now.toISOString(),
      context: {
        pool: record.pool,
        pool_name: record.pool_name,
        source_wallet: record.source_wallet,
        entry_reason: parsed.entry,
        exit_reason: parsed.exit,
        their_pnl_pct: record.source_pnl_pct,
        our_pnl_pct: ourPnlPct,
      },
    });
  } catch (e) {
    ctx.logger.warn("follow-learn", "lesson write failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { ...parsed, lessonId: null };
  }

  return { ...parsed, lessonId: id };
}
