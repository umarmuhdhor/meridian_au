import type { AppContext } from "../tools/context.js";
import type { LLMClient } from "../../ports/llm-client.js";
import type { LessonRepo } from "../../ports/lesson-repo.js";
import type { Logger } from "../../ports/logger.js";
import type { Lesson, PerformanceRecord } from "../../domain/schemas/lesson.js";
import { MATCH_PROMPT_RULES, formatMatchContext } from "../../domain/rules/lesson-match.js";
import { converseForMatchedLesson, matchSuffix } from "../learning/matched-lesson.js";
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
  /** Per-close model choice (see CloseReviewDeps.modelFor); falls back to `model`. */
  modelFor?: ((pnlPct: number) => string) | undefined;
}

const SYSTEM_PROMPT = [
  "You analyse a copy-traded Meteora DLMM position after the fact.",
  "Meridian mirrored a wallet it follows: it entered when that wallet entered and exited when that wallet exited.",
  "Meridian did NOT choose this pool and applied none of its own entry filters, so it has no thesis of its own to review.",
  "Your job: infer, from the market structure captured at entry and at exit, WHY the followed wallet plausibly",
  "entered and WHY it plausibly exited. Be concrete about the numbers you were given; if the evidence is too thin,",
  "say so plainly rather than inventing a reason.",
  "",
  "Then extract at most ONE NARROW rule for Meridian's own SCREENER, which picks pools independently and reads this",
  "lesson before every deploy. OUTCOME (Meridian's result on this mirror) decides the direction: PREFER for a WIN,",
  "AVOID for a LOSS. The rule must be checkable from entry-time data only (the ENTRY line), never exit data.",
  "curve is a forbidden strategy — never recommend it.",
  "",
  ...MATCH_PROMPT_RULES,
  "",
  "Answer in exactly four lines, no preamble, no markdown:",
  "ENTRY: <one sentence — what the wallet likely saw at entry>",
  "EXIT: <one sentence — what likely triggered their exit>",
  "LESSON: <one PREFER/AVOID rule under 200 characters, naming the same conditions as MATCH> | NONE",
  "MATCH: <cond AND cond [AND cond]> | NONE",
].join("\n");

function buildUserPrompt(
  record: MirroredPosition,
  self: PerformanceRecord,
  history: readonly PerformanceRecord[],
): string {
  const lines: string[] = [];
  lines.push(`OUTCOME: ${self.pnl_pct > 0 ? "WIN" : "LOSS"} (our net ${self.pnl_pct.toFixed(2)}%)`);
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

  const entry = record.entry_technicals ? formatTechnicalsBlock(record.entry_technicals) : null;
  const exit = record.exit_technicals ? formatTechnicalsBlock(record.exit_technicals) : null;
  lines.push("");
  lines.push("MARKET STRUCTURE AT ENTRY:");
  lines.push(entry ?? "(unavailable)");
  lines.push("");
  lines.push("MARKET STRUCTURE AT EXIT:");
  lines.push(exit ?? "(unavailable)");
  lines.push("");
  lines.push(...formatMatchContext(self, history));
  return lines.join("\n");
}

export interface RetrospectiveOutcome {
  lessonId: string | null;
  entry: string | null;
  exit: string | null;
  rule: string | null;
  /** Why a proposed rule was dropped (failed the MATCH backtest), when it was. */
  rejected?: string | null;
}

const sanitize = (t: string): string =>
  t.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, LESSON_MAX_LEN);

/** Pull ENTRY / EXIT / LESSON / MATCH out of the model's reply. Tolerates extra prose. */
export function parseRetrospective(text: string): {
  entry: string | null;
  exit: string | null;
  rule: string | null;
  match: string | null;
} {
  const grab = (label: string): string | null => {
    const m = new RegExp(`^[\\s*\\-]*${label}\\s*:\\s*(.+)$`, "im").exec(text);
    return m?.[1] ? sanitize(m[1]) : null;
  };
  const none = (v: string | null) => (v && !/^none\b/i.test(v) ? v : null);
  return { entry: grab("ENTRY"), exit: grab("EXIT"), rule: none(grab("LESSON")), match: none(grab("MATCH")) };
}

/** Everything the learner touches — a subset of AppContext, so the one-off redo can run it too. */
export interface MirrorLearnDeps {
  lessons: LessonRepo;
  logger: Logger;
  clock: { now(): Date };
  llm: LLMClient;
  model: string;
  /** Picks the model from the mirror's outcome (expensive reviewer for big losses). */
  modelFor?: ((pnlPct: number) => string) | undefined;
}

/**
 * The mirror's settled performance record when it exists (the close_position post-hook
 * writes it before this runs), else a stand-in from the mirror record. Null when the
 * outcome is unknown — a rule can't be checked against an outcome nobody measured.
 */
export function mirrorSelf(
  record: MirroredPosition,
  performance: readonly PerformanceRecord[],
  ourPnlPct: number | null,
): PerformanceRecord | null {
  const found = performance.findLast((p) => p.position === record.position);
  if (found) return found.entry_technicals?.length ? found : { ...found, entry_technicals: record.entry_technicals ?? [] };
  if (ourPnlPct == null) return null;
  return {
    position: record.position,
    pool: record.pool,
    pool_name: record.pool_name ?? null,
    pnl_pct: ourPnlPct,
    close_reason: "mirror",
    entry_technicals: record.entry_technicals ?? [],
  } as PerformanceRecord;
}

/**
 * Infer the wallet's entry/exit reasoning and, when the model proposes a rule that passes
 * the MATCH backtest over every past trade (screener AND mirrors — the lesson steers the
 * screener, and a mirror's outcome is evidence about that market structure), store it as
 * a `[follow:<label>]` lesson. `replaceLessonId` retires an earlier follow lesson for the
 * same mirror in the same write (one-off redo). Throws only when the first LLM reply is
 * unusable; callers decide whether to retry.
 */
export async function learnFromMirror(
  deps: MirrorLearnDeps,
  record: MirroredPosition,
  ourPnlPct: number | null,
  opts: { replaceLessonId?: string | null; extraTags?: readonly string[] } = {},
): Promise<RetrospectiveOutcome> {
  const loaded = await deps.lessons.load();
  if (!loaded.ok) throw new Error("lessons.json could not be read");
  const history = loaded.value.performance.filter((p) => p.entry_technicals?.length);
  const self = mirrorSelf(record, loaded.value.performance, ourPnlPct);
  if (!self) return { lessonId: null, entry: null, exit: null, rule: null, rejected: "outcome unknown" };

  const model = deps.modelFor?.(self.pnl_pct) ?? deps.model;
  const r = await converseForMatchedLesson({
    llm: deps.llm,
    model,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(record, self, history),
    parse: parseRetrospective,
    usable: (x) => !!(x.entry || x.exit || x.rule),
    self,
    outcome: self.pnl_pct > 0 ? "win" : "loss",
    history,
    replyFormat: "ENTRY / EXIT / LESSON / MATCH lines",
  });
  const entry = r.last.entry ?? r.first.entry;
  const exit = r.last.exit ?? r.first.exit;

  if (!r.accepted) {
    if (r.rejected) {
      deps.logger.info("follow-learn", "proposed rule dropped — too broad for the screener", {
        position: record.position.slice(0, 8),
        reason: r.rejected,
      });
    }
    if (opts.replaceLessonId) await retire(deps.lessons, opts.replaceLessonId);
    return { lessonId: null, entry, exit, rule: null, rejected: r.rejected };
  }

  const now = deps.clock.now();
  const id = `l-follow-${now.getTime()}`;
  const label = record.source_label || record.source_wallet.slice(0, 8);
  const lesson: Lesson = {
    id,
    rule: sanitize(`[follow:${label}] ${r.accepted.rule}${matchSuffix(r.accepted.match, r.accepted.backtest)}`),
    tags: ["follow", `wallet:${record.source_wallet.slice(0, 8)}`, ...(opts.extraTags ?? [])],
    role: "SCREENER",
    pinned: false,
    sourceType: "follow-retrospective",
    created_at: now.toISOString(),
    match: r.accepted.match,
    backtest: { wins: r.accepted.backtest.wins, losses: r.accepted.backtest.losses, at: now.toISOString() },
    context: {
      pool: record.pool,
      pool_name: record.pool_name,
      source_wallet: record.source_wallet,
      entry_reason: entry,
      exit_reason: exit,
      their_pnl_pct: record.source_pnl_pct,
      our_pnl_pct: self.pnl_pct,
    },
  };
  const fresh = await deps.lessons.load();
  if (!fresh.ok) throw new Error("lessons.json could not be read");
  const file = fresh.value;
  if (opts.replaceLessonId) {
    const li = file.lessons.findIndex((l) => l.id === opts.replaceLessonId && !l.pinned);
    if (li >= 0) file.lessons.splice(li, 1);
  }
  file.lessons.push(lesson);
  await deps.lessons.save(file);
  return { lessonId: id, entry, exit, rule: lesson.rule, rejected: null };
}

async function retire(lessons: LessonRepo, id: string): Promise<void> {
  const fresh = await lessons.load();
  if (!fresh.ok) return;
  const li = fresh.value.lessons.findIndex((l) => l.id === id && !l.pinned);
  if (li < 0) return;
  fresh.value.lessons.splice(li, 1);
  await lessons.save(fresh.value);
}

/**
 * Post-close retrospective for a mirrored position.
 *
 * Two layers, so the feature still learns something when the LLM is unavailable:
 *   - Always: the entry/exit technicals are persisted on the mirror record itself,
 *     which is the durable evidence a later analysis can mine.
 *   - When an LLM is wired: infer the wallet's entry and exit reasoning and, if it yields
 *     a rule narrow enough to pass the MATCH backtest, persist it as a tagged lesson.
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
  try {
    return await learnFromMirror(
      { lessons: ctx.repos.lessons, logger: ctx.logger, clock: ctx.clock, llm, model, modelFor: deps.modelFor },
      record,
      ourPnlPct,
    );
  } catch (e) {
    ctx.logger.warn("follow-learn", "retrospective failed", {
      position: record.position.slice(0, 8),
      error: e instanceof Error ? e.message : String(e),
    });
    return empty;
  }
}
