import type { AppContext } from "../tools/context.js";
import type { LLMClient } from "../../ports/llm-client.js";
import type { LessonRepo } from "../../ports/lesson-repo.js";
import type { CloseReview, Lesson, PerformanceRecord, ShadowReplay } from "../../domain/schemas/lesson.js";
import { isPnlSettled } from "../../domain/format/close-pnl.js";
import { formatTechnicalsBlock } from "../../domain/format/technicals.js";
import { MATCH_PROMPT_RULES, formatMatchContext, type MatchBacktest } from "../../domain/rules/lesson-match.js";
import {
  MATCHED_LESSON_MAX_REFINES,
  MATCHED_LESSON_MAX_TOKENS,
  converseForMatchedLesson,
  matchSuffix,
} from "./matched-lesson.js";
import { computeShadowReplay, shadowDelta } from "./shadow-replay.js";

/** How often the reviewer runs. Cheap when there is nothing to review (one file read). */
export const CLOSE_REVIEW_INTERVAL_MS = 5 * 60_000;
/** Only closes this recent are reviewed — the feature does not back-fill old history. */
export const CLOSE_REVIEW_LOOKBACK_MS = 24 * 60 * 60_000;
/**
 * Wait this long for Meteora's settled PnL (finalize-performance) before reviewing on
 * the close-time estimate instead. A win/loss verdict on the wrong numbers would teach
 * the wrong lesson, so settled figures are worth a short wait.
 */
export const CLOSE_REVIEW_SETTLE_WAIT_MS = 20 * 60_000;
/** Bounds LLM spend per tick when several positions closed together. */
export const CLOSE_REVIEW_MAX_PER_TICK = 3;
/** LLM failures tolerated per record before it is reviewed without a lesson. */
export const CLOSE_REVIEW_MAX_LLM_ATTEMPTS = 3;
/** Completion budget per call; at the old 400 the reasoning model's reply was cut to "WHAT". */
export const CLOSE_REVIEW_MAX_TOKENS = MATCHED_LESSON_MAX_TOKENS;
/** Extra LLM turns allowed to narrow a MATCH the backtest rejected, before giving up on a lesson. */
export const CLOSE_REVIEW_MAX_REFINES = MATCHED_LESSON_MAX_REFINES;

const LESSON_MAX_LEN = 500;
const RULE_MAX_LEN = 260;

export type CloseOutcome = "win" | "loss";

/** Win = positive net PnL (fees included), the same definition the candidate history uses. */
export function classifyOutcome(p: PerformanceRecord): { outcome: CloseOutcome; net_usd: number | null } {
  const net = p.pnl_usd != null ? p.pnl_usd + (p.fees_earned_usd ?? 0) : null;
  return { outcome: p.pnl_pct > 0 ? "win" : "loss", net_usd: net != null ? Math.round(net * 100) / 100 : null };
}

function closedAtMs(p: PerformanceRecord): number {
  return Date.parse(String(p.closed_at ?? p.recorded_at));
}

/**
 * Pure — the records due for review this tick: unreviewed, recent, not a follow mirror
 * (those get their own retrospective in follow/learn.ts), and either settled or past the
 * settle wait. Newest first.
 */
export function pickReviewable(
  performance: readonly PerformanceRecord[],
  now: Date,
  mirrored: ReadonlySet<string>,
  limit = CLOSE_REVIEW_MAX_PER_TICK,
): PerformanceRecord[] {
  const t = now.getTime();
  return performance
    .filter((p) => !p.review && !mirrored.has(p.position))
    .filter((p) => {
      const ts = closedAtMs(p);
      if (!Number.isFinite(ts) || t - ts > CLOSE_REVIEW_LOOKBACK_MS) return false;
      return isPnlSettled(p) || t - ts >= CLOSE_REVIEW_SETTLE_WAIT_MS;
    })
    .reverse()
    .slice(0, limit);
}

const SYSTEM_PROMPT = [
  "You review ONE closed Meteora DLMM liquidity position that Meridian, an autonomous LP bot, opened and closed.",
  "The outcome (WIN or LOSS) is already decided from the settled PnL, fees included. Do not dispute it.",
  "Your job: explain WHY it won or lost, and extract ONE reusable, NARROW rule for choosing FUTURE entries.",
  "",
  "The rule is injected into the screener's prompt before every future deploy decision, so it must be checkable",
  "from what the screener sees at entry time (the ENTRY line below). Exit-time data explains what happened but",
  "cannot be seen at entry — never write a rule that depends on it.",
  "For a WIN write a PREFER rule (what to repeat); for a LOSS write an AVOID rule (what to skip).",
  "curve is a forbidden strategy — never recommend it.",
  "",
  ...MATCH_PROMPT_RULES,
  "",
  "Answer in exactly four lines, no preamble, no markdown:",
  "WHAT: <one sentence — what happened to the position, with numbers>",
  "WHY: <one sentence — the most likely cause, citing the entry/exit numbers>",
  "LESSON: <one PREFER/AVOID rule under 220 characters, naming the same conditions as MATCH> | NONE",
  "MATCH: <cond AND cond [AND cond]>, e.g. 1h.from_high < -32 AND 1h.trend = DOWN AND fee_tvl_ratio < 0.3 | NONE",
].join("\n");

const fmt = (n: number | null | undefined, digits = 2): string =>
  n == null || !Number.isFinite(n) ? "?" : n.toFixed(digits);

function buildUserPrompt(
  p: PerformanceRecord,
  verdict: { outcome: CloseOutcome; net_usd: number | null },
  applied: ReadonlyArray<{ id: string; rule: string | null }>,
  existing: readonly Lesson[],
  history: readonly PerformanceRecord[],
): string {
  const lines: string[] = [];
  lines.push(`OUTCOME: ${verdict.outcome.toUpperCase()}`);
  lines.push(`Pool: ${p.pool_name ?? p.pool ?? "?"}`);
  lines.push(
    `PnL: ${fmt(p.pnl_pct)}% net  (price PnL $${fmt(p.pnl_usd)}, fees $${fmt(p.fees_earned_usd)}, net $${fmt(verdict.net_usd)})` +
      `  source=${p.pnl_source ?? "estimate"}`,
  );
  if (p.amount_sol != null) lines.push(`Size: ${p.amount_sol} SOL`);
  if (p.strategy) lines.push(`Strategy: ${p.strategy}`);
  if (p.bin_range?.min != null && p.bin_range?.max != null) {
    lines.push(`Bin range: ${p.bin_range.min} → ${p.bin_range.max} (${p.bin_range.max - p.bin_range.min} bins, step ${p.bin_step ?? "?"})`);
  }
  if (p.minutes_held != null) lines.push(`Held: ${p.minutes_held} minutes`);
  lines.push(`Close reason: ${p.close_reason}`);
  const entryFields = [
    p.volatility != null ? `volatility=${fmt(p.volatility)}` : null,
    p.fee_tvl_ratio != null ? `fee_tvl_ratio=${fmt(p.fee_tvl_ratio, 4)}` : null,
    p.organic_score != null ? `organic=${fmt(p.organic_score)}` : null,
    p.entry_mcap != null ? `mcap_in=$${Math.round(p.entry_mcap)}` : null,
    p.exit_mcap != null ? `mcap_out=$${Math.round(p.exit_mcap)}` : null,
    p.holders_at_entry != null ? `holders=${p.holders_at_entry}` : null,
  ].filter(Boolean);
  if (entryFields.length) lines.push(`Entry signals: ${entryFields.join("  ")}`);
  if (p.entry_reason) lines.push(`Screener's reason for entering: ${p.entry_reason}`);
  if (applied.length) {
    lines.push("Lessons the screener said it applied at entry:");
    for (const a of applied) lines.push(`  [${a.id}] ${a.rule ?? "(lesson no longer exists)"}`);
  }

  const entry = p.entry_technicals?.length ? formatTechnicalsBlock(p.entry_technicals) : null;
  const exit = p.exit_technicals?.length ? formatTechnicalsBlock(p.exit_technicals) : null;
  lines.push("");
  lines.push("MARKET STRUCTURE AT ENTRY:");
  lines.push(entry ?? "(unavailable)");
  lines.push("");
  lines.push("MARKET STRUCTURE AT EXIT:");
  lines.push(exit ?? "(unavailable)");

  lines.push("");
  lines.push(...formatMatchContext(p, history));

  if (existing.length) {
    lines.push("");
    lines.push("EXISTING LESSONS (do not duplicate):");
    for (const l of existing) lines.push(`  - ${l.rule}`);
  }
  return lines.join("\n");
}

const sanitize = (t: string, max: number): string =>
  t.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export interface ParsedCloseReview {
  what: string | null;
  why: string | null;
  /** null when the model answered NONE or gave no LESSON line. */
  rule: string | null;
  /** Raw MATCH expression; null when absent or NONE. */
  match: string | null;
}

/** Pull WHAT / WHY / LESSON / MATCH out of the reply. Tolerates extra prose and bullets. */
export function parseCloseReview(text: string): ParsedCloseReview {
  const grab = (label: string): string | null => {
    const m = new RegExp(`^[\\s*\\-]*${label}\\s*:\\s*(.+)$`, "im").exec(text);
    return m?.[1] ? sanitize(m[1], LESSON_MAX_LEN) : null;
  };
  const lesson = grab("LESSON");
  const rule = lesson && !/^none\b/i.test(lesson) ? sanitize(lesson, RULE_MAX_LEN) : null;
  const match = grab("MATCH");
  return { what: grab("WHAT"), why: grab("WHY"), rule, match: match && !/^none\b/i.test(match) ? match : null };
}

/** A review after the MATCH backtest. `rule` is cleared when the MATCH was rejected. */
export interface CheckedCloseReview extends ParsedCloseReview {
  /** Normalised MATCH that passed the backtest (null when there is no lesson). */
  match: string | null;
  backtest: MatchBacktest | null;
  /** Why the lesson was dropped after the model's last attempt — too broad or unparseable. */
  rejected: string | null;
}

/**
 * Reviewer conversation (see `converseForMatchedLesson`): throws when the first reply is
 * unusable so the caller retries; a proposed rule must pass the MATCH backtest, possibly
 * after narrowing, or it is dropped while WHAT/WHY are kept.
 */
async function askReviewer(
  llm: LLMClient,
  model: string,
  perf: PerformanceRecord,
  verdict: { outcome: CloseOutcome; net_usd: number | null },
  applied: ReadonlyArray<{ id: string; rule: string | null }>,
  existing: readonly Lesson[],
  history: readonly PerformanceRecord[],
): Promise<CheckedCloseReview> {
  const r = await converseForMatchedLesson({
    llm,
    model,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(perf, verdict, applied, existing, history),
    parse: parseCloseReview,
    usable: (x) => !!(x.what || x.why || x.rule),
    self: perf,
    outcome: verdict.outcome,
    history,
    replyFormat: "WHAT / WHY / LESSON / MATCH lines",
  });
  return {
    what: r.last.what ?? r.first.what,
    why: r.last.why ?? r.first.why,
    rule: r.accepted?.rule ?? null,
    match: r.accepted?.match ?? null,
    backtest: r.accepted?.backtest ?? null,
    rejected: r.rejected,
  };
}

type AcceptedReview = CheckedCloseReview & { rule: string; match: string; backtest: MatchBacktest };
const isAccepted = (r: CheckedCloseReview | null): r is AcceptedReview => !!(r?.rule && r.match && r.backtest);

function buildAutoLesson(
  perf: PerformanceRecord,
  verdict: { outcome: CloseOutcome; net_usd: number | null },
  review: AcceptedReview,
  now: Date,
  extraTags: readonly string[] = [],
): Lesson {
  const pool = perf.pool_name ?? perf.pool?.slice(0, 8) ?? "?";
  const bt = review.backtest;
  return {
    id: `l-close-${now.getTime()}-${perf.position.slice(0, 6)}`,
    // The condition and its track record ride along in the text the screener reads, so it
    // sees exactly when the rule applies — and that it does NOT apply to anything else.
    rule: sanitize(
      `[auto ${verdict.outcome.toUpperCase()} ${pool} ${perf.pnl_pct >= 0 ? "+" : ""}${perf.pnl_pct.toFixed(1)}%] ${review.rule}` +
        matchSuffix(review.match, bt),
      LESSON_MAX_LEN,
    ),
    tags: ["auto", "close-review", verdict.outcome, ...(perf.strategy ? [perf.strategy] : []), ...extraTags],
    outcome: verdict.outcome,
    sourceType: "close-review",
    role: "SCREENER",
    pinned: false,
    created_at: now.toISOString(),
    match: review.match,
    backtest: { wins: bt.wins, losses: bt.losses, at: now.toISOString() },
    context: {
      position: perf.position,
      pool: perf.pool ?? null,
      pool_name: perf.pool_name ?? null,
      pnl_pct: perf.pnl_pct,
      net_usd: verdict.net_usd,
      close_reason: perf.close_reason,
      what: review.what,
      why: review.why,
    },
  };
}

/** Closes the screener actually chose — follow mirrors bypass screening, so they are not evidence for or against a screening rule. */
export function screenerHistory(performance: readonly PerformanceRecord[], mirrored: ReadonlySet<string>): PerformanceRecord[] {
  return performance.filter((p) => !mirrored.has(p.position) && !/^mirrored\b/i.test(p.entry_reason ?? ""));
}

export interface CloseReviewDeps {
  ctx: AppContext;
  llm?: LLMClient | undefined;
  model?: string | undefined;
  /**
   * Per-close model choice (llm.learningModel / learningImportantModel), resolved at call
   * time so dashboard edits apply on the next review. Falls back to `model`.
   */
  modelFor?: ((pnlPct: number) => string) | undefined;
  /** LLM failures per position, kept across ticks by the caller (in-process). */
  attempts?: Map<string, number>;
}

export interface CloseReviewResult {
  position: string;
  review: CloseReview;
}

/**
 * Post-close learning pass. For each settled close (win or loss):
 *
 *   1. Deterministic: score every lesson the screener cited in `lessons_applied` at
 *      deploy — `stats.applied/wins/losses` on the lesson. That track record is rendered
 *      next to the lesson in future prompts ("applied 5x → 2W/3L").
 *   2. LLM: ask why it won or lost and save one PREFER/AVOID rule as an unpinned
 *      `close-review` lesson. Unpinned lessons rotate through the prompt's RECENT window;
 *      pin one from the dashboard to keep it permanently.
 *   3. Stamp `review` on the performance record (dashboard Learning / Pelajaran pages).
 *      No Telegram card — it was too long for the group; the dashboard is the record.
 *
 * Never throws — a failed review must not disturb trading.
 */
export async function runCloseReview(deps: CloseReviewDeps): Promise<CloseReviewResult[]> {
  const { ctx, llm, model } = deps;
  const attempts = deps.attempts ?? new Map<string, number>();
  if (!ctx.config.management.closeReviewEnabled) return [];

  try {
    const loaded = await ctx.repos.lessons.load();
    if (!loaded.ok) return [];

    let mirrored: Set<string>;
    try {
      mirrored = new Set((await ctx.repos.follow.listMirrored()).map((m) => m.position));
    } catch {
      // Unknown which closes were mirrors — wait rather than review one twice.
      return [];
    }

    const now = ctx.clock.now();
    const pending = pickReviewable(loaded.value.performance, now, mirrored);
    const history = screenerHistory(loaded.value.performance, mirrored);
    const out: CloseReviewResult[] = [];

    for (const perf of pending) {
      const verdict = classifyOutcome(perf);
      const byId = new Map(loaded.value.lessons.map((l) => [l.id, l]));
      const applied = (perf.lessons_applied ?? []).map((id) => ({ id, rule: byId.get(id)?.rule ?? null }));

      let parsed: CheckedCloseReview | null = null;
      let note: string | null = null;
      const reviewModel = deps.modelFor?.(perf.pnl_pct) ?? model;
      if (llm && reviewModel) {
        try {
          parsed = await askReviewer(llm, reviewModel, perf, verdict, applied, loaded.value.lessons, history);
          if (!parsed.rule) note = parsed.rejected ? "rule_too_broad" : "llm_none";
        } catch (e) {
          parsed = null;
          const n = (attempts.get(perf.position) ?? 0) + 1;
          attempts.set(perf.position, n);
          ctx.logger.warn("close-review", `LLM call failed for ${perf.position.slice(0, 8)} (${n}/${CLOSE_REVIEW_MAX_LLM_ATTEMPTS})`, {
            error: e instanceof Error ? e.message : String(e),
          });
          if (n < CLOSE_REVIEW_MAX_LLM_ATTEMPTS) continue; // retry next tick
          note = "llm_failed";
        }
      } else {
        note = "llm_unavailable";
      }
      attempts.delete(perf.position);

      // Shadow mode — computed here (after the LLM, before the one write) so a retried
      // review does not refetch candles. Recorded and shown only; never fed to the LLM.
      const shadow = await computeShadowReplay(ctx, perf);

      const committed = await commitReview(ctx, perf, verdict, parsed, note, llm && reviewModel ? reviewModel : null, shadow);
      if (!committed) continue;
      out.push({ position: perf.position, review: committed.review });
    }
    return out;
  } catch (e) {
    ctx.logger.warn("close-review", "review pass failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

interface ScoredLesson {
  id: string;
  wins: number;
  losses: number;
}

/**
 * One read-modify-write of lessons.json: add the auto lesson, bump the cited lessons'
 * stats and stamp the review. Reloaded fresh (the LLM call may have taken seconds while
 * a close appended a record) and re-checked so a record is never scored twice.
 */
async function commitReview(
  ctx: AppContext,
  perf: PerformanceRecord,
  verdict: { outcome: CloseOutcome; net_usd: number | null },
  parsed: CheckedCloseReview | null,
  note: string | null,
  reviewModel: string | null,
  shadow: ShadowReplay | null = null,
): Promise<{ review: CloseReview; scored: ScoredLesson[] } | null> {
  const fresh = await ctx.repos.lessons.load();
  if (!fresh.ok) return null;
  const file = fresh.value;
  const idx = file.performance.findLastIndex((p) => p.position === perf.position);
  if (idx < 0 || file.performance[idx]!.review) return null;

  const now = ctx.clock.now().toISOString();
  const pool = perf.pool_name ?? perf.pool?.slice(0, 8) ?? "?";

  let lessonId: string | null = null;
  let lessonRule: string | null = null;
  if (isAccepted(parsed)) {
    const lesson = buildAutoLesson(perf, verdict, parsed, ctx.clock.now());
    lessonId = lesson.id;
    lessonRule = lesson.rule;
    file.lessons.push(lesson);
  }

  const scored: ScoredLesson[] = [];
  const appliedOut: Array<{ id: string; rule: string | null }> = [];
  for (const id of new Set(perf.lessons_applied ?? [])) {
    const li = file.lessons.findIndex((l) => l.id === id);
    if (li < 0) {
      appliedOut.push({ id, rule: null });
      continue;
    }
    const l = file.lessons[li]!;
    const prev = l.stats ?? { applied: 0, wins: 0, losses: 0 };
    const stats = {
      applied: prev.applied + 1,
      wins: prev.wins + (verdict.outcome === "win" ? 1 : 0),
      losses: prev.losses + (verdict.outcome === "loss" ? 1 : 0),
      last_applied_at: perf.closed_at ?? now,
    };
    file.lessons[li] = { ...l, stats };
    scored.push({ id, wins: stats.wins, losses: stats.losses });
    appliedOut.push({ id, rule: l.rule });
  }

  const review: CloseReview = {
    reviewed_at: now,
    outcome: verdict.outcome,
    net_usd: verdict.net_usd,
    pnl_source: perf.pnl_source ?? "estimate",
    what: parsed?.what ?? null,
    why: parsed?.why ?? null,
    lesson_id: lessonId,
    lesson_rule: lessonRule,
    lessons_applied: appliedOut,
    note,
    ...(parsed?.rejected ? { rejected_reason: parsed.rejected } : {}),
    ...(reviewModel ? { model: reviewModel } : {}),
  };
  file.performance[idx] = { ...file.performance[idx]!, review, ...(shadow ? { shadow } : {}) };
  await ctx.repos.lessons.save(file);

  ctx.logger.info("close-review", `reviewed ${perf.position.slice(0, 8)} ${pool} → ${verdict.outcome}`, {
    pnl_pct: perf.pnl_pct,
    lesson_id: lessonId,
    scored: scored.map((s) => `${s.id}:${s.wins}W/${s.losses}L`),
    note,
    shadow_delta_pts: shadow ? shadowDelta(file.performance[idx]!) : null,
  });
  return { review, scored };
}

// ── Backfill ────────────────────────────────────────────────────────────────────────
//
// Until 2026-10-07 the reviewer ran with max_tokens 400; the reasoning model spent that
// thinking, the reply was cut to "WHAT", and the review was stamped as if the model had
// answered LESSON: NONE. Those records are marked reviewed, so the tick never revisits
// them. The backfill re-asks the LLM for exactly those records and fills in
// what/why/lesson WITHOUT re-scoring the cited lessons — their W/L was already counted
// when the empty review was committed.

export interface BackfillCandidate {
  position: string;
  pool: string;
  pnl_pct: number;
  outcome: CloseOutcome;
  closed_at: string | null;
}

export interface BackfillResult extends BackfillCandidate {
  status: "lesson" | "no_lesson" | "too_broad" | "failed" | "skipped";
  what?: string | null;
  why?: string | null;
  lesson_id?: string | null;
  lesson_rule?: string | null;
  /** Rejection reason when the proposed rule failed the backtest. */
  rejected?: string | null;
  /** The earlier auto lesson this redo replaced (deleted), if any. */
  replaced_lesson?: string | null;
  error?: string;
}

export interface BackfillDeps {
  lessons: LessonRepo;
  llm: LLMClient;
  model: string;
  clock: { now(): Date };
  includeWins?: boolean;
  /** Follow-mirror positions — excluded from the backtest history. */
  mirrored?: ReadonlySet<string>;
  /**
   * Positions to review AGAIN even though their review is not empty. Their previous
   * auto lesson (unpinned, close-review) is deleted and replaced by the new, backtested
   * one — or by nothing when no narrow rule exists. Pinned lessons are never removed.
   */
  redo?: ReadonlySet<string>;
  /** Per-record LLM attempts before giving up on it (left as-is, can be re-run). */
  maxAttempts?: number;
  /** Process at most this many records (default: all). */
  stopAfter?: number;
  onResult?: (r: BackfillResult) => void;
}

/** An empty review: the reviewer produced nothing at all — not WHAT, not WHY, no lesson. */
export function isEmptyReview(p: PerformanceRecord): boolean {
  const r = p.review;
  if (!r) return false;
  if (r.what || r.why || r.lesson_id) return false;
  return r.note === "llm_none" || r.note === "llm_failed";
}

const isTarget = (p: PerformanceRecord, redo: ReadonlySet<string>) =>
  isEmptyReview(p) || (!!p.review && redo.has(p.position));

export function pickBackfillable(
  performance: readonly PerformanceRecord[],
  includeWins = false,
  redo: ReadonlySet<string> = new Set(),
): BackfillCandidate[] {
  return performance
    .filter((p) => isTarget(p, redo))
    .filter((p) => includeWins || redo.has(p.position) || p.review!.outcome === "loss")
    .map((p) => ({
      position: p.position,
      pool: p.pool_name ?? p.pool?.slice(0, 8) ?? "?",
      pnl_pct: p.pnl_pct,
      outcome: p.review!.outcome,
      closed_at: (p.closed_at ?? p.recorded_at ?? null) as string | null,
    }))
    .reverse();
}

export async function backfillCloseReviews(deps: BackfillDeps): Promise<BackfillResult[]> {
  const { lessons, llm, model, clock } = deps;
  const redo = deps.redo ?? new Set<string>();
  const mirrored = deps.mirrored ?? new Set<string>();
  const maxAttempts = deps.maxAttempts ?? CLOSE_REVIEW_MAX_LLM_ATTEMPTS;
  const loaded = await lessons.load();
  if (!loaded.ok) throw new Error("lessons.json could not be read — refusing to backfill");

  const out: BackfillResult[] = [];
  const emit = (r: BackfillResult) => {
    out.push(r);
    deps.onResult?.(r);
  };
  const done = new Set<string>();

  const candidates = pickBackfillable(loaded.value.performance, deps.includeWins, redo).slice(0, deps.stopAfter ?? Infinity);
  for (const cand of candidates) {
    // Fresh read per record: earlier iterations added lessons (dedup context) and the
    // live daemon may have written the file meanwhile.
    const before = await lessons.load();
    if (!before.ok) throw new Error("lessons.json could not be read — stopping");
    const perf = before.value.performance.findLast((p) => p.position === cand.position);
    if (!perf || !isTarget(perf, redo) || done.has(cand.position)) {
      emit({ ...cand, status: "skipped" });
      continue;
    }
    const prior = perf.review!;
    const verdict = { outcome: prior.outcome, net_usd: prior.net_usd ?? null };
    // The lessons as cited at deploy, recorded on the review — not re-resolved, since a
    // cited lesson may have been edited or deleted since.
    const applied = prior.lessons_applied;
    // Don't show the model the lesson this redo is about to replace as "existing".
    const existing = before.value.lessons.filter((l) => l.id !== prior.lesson_id);
    const history = screenerHistory(before.value.performance, mirrored);

    let reviewed: CheckedCloseReview | null = null;
    let lastError = "";
    for (let i = 1; i <= maxAttempts && !reviewed; i++) {
      try {
        reviewed = await askReviewer(llm, model, perf, verdict, applied, existing, history);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    if (!reviewed) {
      emit({ ...cand, status: "failed", error: lastError });
      continue;
    }

    // Commit: reload once more right before writing to keep the race window tiny.
    const fresh = await lessons.load();
    if (!fresh.ok) throw new Error("lessons.json could not be read — stopping");
    const file = fresh.value;
    const idx = file.performance.findLastIndex((p) => p.position === cand.position);
    if (idx < 0 || !isTarget(file.performance[idx]!, redo)) {
      emit({ ...cand, status: "skipped" });
      continue;
    }
    const current = file.performance[idx]!.review!;

    // Redo: retire the earlier auto lesson for this position. Its W/L stats, if any, were
    // earned by the screener citing it — they go with it; the new lesson starts clean.
    let replaced: string | null = null;
    if (current.lesson_id) {
      const li = file.lessons.findIndex((l) => l.id === current.lesson_id);
      const old = li >= 0 ? file.lessons[li]! : null;
      if (old && old.sourceType === "close-review" && !old.pinned) {
        file.lessons.splice(li, 1);
        replaced = old.id;
      }
    }

    const now = clock.now();
    let lessonId: string | null = null;
    let lessonRule: string | null = null;
    if (isAccepted(reviewed)) {
      const lesson = buildAutoLesson(perf, verdict, reviewed, now, ["backfill"]);
      lessonId = lesson.id;
      lessonRule = lesson.rule;
      file.lessons.push(lesson);
    } else if (current.lesson_id && !replaced) {
      // A pinned (human-kept) lesson stays linked.
      lessonId = current.lesson_id;
      lessonRule = current.lesson_rule ?? null;
    }
    const note = lessonId ? null : reviewed.rejected ? "rule_too_broad" : "llm_none";
    file.performance[idx] = {
      ...file.performance[idx]!,
      review: {
        ...current,
        what: reviewed.what,
        why: reviewed.why,
        lesson_id: lessonId,
        lesson_rule: lessonRule,
        note,
        rejected_reason: reviewed.rejected ?? null,
        backfilled_at: now.toISOString(),
      },
    };
    await lessons.save(file);
    done.add(cand.position);
    emit({
      ...cand,
      status: isAccepted(reviewed) ? "lesson" : reviewed.rejected ? "too_broad" : "no_lesson",
      what: reviewed.what,
      why: reviewed.why,
      lesson_id: lessonId,
      lesson_rule: lessonRule,
      rejected: reviewed.rejected,
      replaced_lesson: replaced,
    });
  }
  return out;
}
