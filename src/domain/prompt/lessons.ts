import type { Lesson } from "../schemas/lesson.js";
import { type CommunityVerdict, isCommunityBackup } from "../rules/community-lessons.js";

/** Unpinned lessons shown per prompt — the auto-learned ones rotate through this window. */
export const RECENT_UNPINNED_IN_PROMPT = 8;

export interface PromptLessons {
  /** Every pinned lesson, newest first. Pinned means "always apply" — none are dropped. */
  pinned: Lesson[];
  /** The newest `recent` unpinned lessons, newest first. */
  recent: Lesson[];
}

/**
 * Pure — choose which lessons reach an LLM prompt.
 *
 * `lessons.json` is append-only, so array order is chronological. Every pinned lesson is
 * kept: until 2026-09-29 the prompt took the FIRST five pinned out of the LAST twenty
 * lessons, which silently dropped the newest pins (the curve ban among them) while
 * older, contradicting ones still went out.
 *
 * Community backup lessons never take one of these slots — see `formatCommunityBlock`.
 */
export function selectPromptLessons(
  lessons: readonly Lesson[],
  opts: { recent?: number } = {},
): PromptLessons {
  const recentN = opts.recent ?? RECENT_UNPINNED_IN_PROMPT;
  const newestFirst = lessons.filter((l) => !isCommunityBackup(l)).reverse();
  return {
    pinned: newestFirst.filter((l) => l.pinned),
    recent: newestFirst.filter((l) => !l.pinned).slice(0, recentN),
  };
}

/**
 * Split for the SCREENER: unpinned lessons that carry a MATCH condition are delivered
 * per candidate (only where the condition holds — see `lessonsForCandidate`), so they
 * leave the general LESSONS block. Keeping them there would invite the LLM to apply a
 * narrow lesson to every coin, and would let them crowd the 8-slot RECENT window. Pinned
 * lessons always stay in the general block — pinning means "always show". Community
 * backup lessons are in neither: they reach the prompt only through the backup path.
 */
export function splitMatchedLessons(lessons: readonly Lesson[]): { general: Lesson[]; matched: Lesson[] } {
  const own = lessons.filter((l) => !isCommunityBackup(l));
  return {
    general: own.filter((l) => !l.match || l.pinned),
    matched: own.filter((l) => !!l.match),
  };
}

function formatTrackRecord(l: Lesson): string {
  const s = l.stats;
  if (!s || s.applied <= 0) return "";
  return `  (applied ${s.applied}x → ${s.wins}W/${s.losses}L)`;
}

function formatLine(l: Lesson): string {
  return `  [${l.id}] ${l.rule}${formatTrackRecord(l)}`;
}

/**
 * Render the LESSONS block body. Each lesson carries its id so the screener can cite
 * the ones it used in `deploy_position.lessons_applied` — that citation is what the
 * close review later scores, producing the "(applied Nx → W/L)" track record.
 */
export function formatLessonsBlock(selected: PromptLessons): string {
  const parts: string[] = [];
  if (selected.pinned.length) {
    parts.push("PINNED (always apply; newest first — a newer rule overrides an older one it contradicts):");
    parts.push(...selected.pinned.map(formatLine));
  }
  if (selected.recent.length) {
    parts.push("RECENT (newest first; includes lessons auto-learned from recent closes):");
    parts.push(...selected.recent.map(formatLine));
  }
  return parts.join("\n");
}

/** Header of every community-backup rendering: the precedence rule travels with the lessons. */
export const COMMUNITY_BACKUP_GUIDE =
  "Distilled from other operators' bots in the Meridian Telegram group — weaker evidence than our own. " +
  "Our own LESSONS and history always win on conflict; use these only where ours say nothing, to tip a " +
  "close call, never as the sole reason for a decision. Cite the id in `lessons_applied` if one shaped " +
  "the decision: our results then score it, and one our trades contradict is withdrawn automatically.";

/**
 * Render the community lessons that carry no MATCH (MATCH ones go on candidates instead).
 * `verdicts` must already be filtered to the usable ones (see `selectCommunityLessons`).
 */
export function formatCommunityBlock(verdicts: readonly CommunityVerdict[]): string {
  const general = verdicts.filter((v) => !v.lesson.match);
  if (!general.length) return "";
  return [COMMUNITY_BACKUP_GUIDE, ...general.map((v) => `${formatLine(v.lesson)}  (${v.own})`)].join("\n");
}
