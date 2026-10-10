import type { Lesson, PerformanceRecord } from "../schemas/lesson.js";
import { matchesRecord, parseMatch } from "./lesson-match.js";

/**
 * Lessons distilled from OTHER operators' bots — the Meridian Telegram group, scraped by
 * scripts/tg-scrape and imported by entrypoints/import-community-lessons.ts. They are a
 * backup to our own learning, never a peer of it:
 *  - they never take an own-lesson slot (PINNED/RECENT, or a candidate's `lessons:` line);
 *  - on a candidate they show only when none of our own MATCH lessons holds for it;
 *  - our own trades judge them, and a lesson our trades contradict is withheld.
 * Pinning one is the operator promoting it to an own lesson, so a pinned community lesson
 * is treated like any other pinned lesson.
 *
 * Judging differs from auto lessons on purpose. An auto lesson is a narrow rule and must
 * catch no past trade of the opposite outcome (`acceptBacktest`). A community lesson is a
 * base-rate caution ("thin pools rug twice as often") whose bucket still wins most of the
 * time, so it is judged by whether our trades in that bucket did worse than our trades
 * overall — the claim it actually makes.
 */
export const COMMUNITY_SOURCE = "community";

export function isCommunityBackup(lesson: Lesson): boolean {
  return lesson.sourceType === COMMUNITY_SOURCE && !lesson.pinned;
}

/** Below this many of our own trades matching a lesson, our data has no say yet. */
export const MIN_OWN_TRADES = 8;
/** A lesson must have been cited on this many of our deploys before its track record counts. */
export const MIN_OWN_APPLIED = 3;

export type CommunityStatus = "untested" | "supported" | "contradicted";

export interface CommunityVerdict {
  lesson: Lesson;
  status: CommunityStatus;
  /** What our own trades say about the lesson — shown next to it in the prompt and logs. */
  own: string;
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

/**
 * Pure — judge one community lesson against our own closed trades. `outcome: "win"` marks
 * a PREFER lesson; anything else is a caution. Either piece of own evidence can contradict
 * it: the deploys that cited it, or (with a MATCH) our trades that fall in its bucket.
 */
export function judgeCommunityLesson(lesson: Lesson, history: readonly PerformanceRecord[]): CommunityVerdict {
  const prefer = lesson.outcome === "win";
  const evidence: string[] = [];
  let contradicted = false;
  let supported = false;

  // Deploys that cited it: a caution is cited when deploying despite it, so our wins
  // count against it; a PREFER is cited when following it, so our losses do.
  const s = lesson.stats;
  if (s && s.applied >= MIN_OWN_APPLIED) {
    const against = prefer ? s.losses : s.wins;
    const forIt = prefer ? s.wins : s.losses;
    evidence.push(`cited on ${s.applied} of our deploys → ${s.wins}W/${s.losses}L`);
    if (against > forIt) contradicted = true;
    else if (forIt > against) supported = true;
  }

  if (lesson.match) {
    const parsed = parseMatch(lesson.match);
    if (!parsed.ok) {
      return { lesson, status: "contradicted", own: `MATCH invalid: ${parsed.error}` };
    }
    const hit = history.filter((p) => matchesRecord(parsed.value, p));
    if (hit.length >= MIN_OWN_TRADES && history.length > hit.length) {
      const inBucket = mean(hit.map((p) => p.pnl_pct));
      const overall = mean(history.map((p) => p.pnl_pct));
      evidence.push(`${hit.length} of our trades match: avg ${pct(inBucket)} vs ${pct(overall)} overall`);
      if (prefer ? inBucket > overall : inBucket < overall) supported = true;
      else contradicted = true;
    } else {
      evidence.push(`${hit.length} of our trades match (need ${MIN_OWN_TRADES})`);
    }
  }

  const status: CommunityStatus = contradicted ? "contradicted" : supported ? "supported" : "untested";
  return { lesson, status, own: `our data: ${status}${evidence.length ? ` — ${evidence.join("; ")}` : ""}` };
}

/**
 * Pure — bring lessons.json's community lessons in line with an imported catalog. The
 * catalog is the source of truth for UNPINNED community lessons: listed ones are added or
 * updated (keeping the `stats` and `created_at` they earned here), unlisted ones are removed.
 * Own lessons, and community lessons the operator pinned, are never touched.
 */
export function mergeCommunityLessons(
  existing: readonly Lesson[],
  incoming: readonly Lesson[],
): { lessons: Lesson[]; added: string[]; updated: string[]; removed: string[] } {
  const pending = new Map(incoming.map((l) => [l.id, l]));
  const taken = new Set(existing.map((l) => l.id));
  const lessons: Lesson[] = [];
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const l of existing) {
    if (!isCommunityBackup(l)) {
      lessons.push(l);
      continue;
    }
    const next = pending.get(l.id);
    pending.delete(l.id);
    if (!next) {
      removed.push(l.id);
      continue;
    }
    lessons.push({
      ...next,
      ...(l.stats ? { stats: l.stats } : {}),
      ...(l.created_at ? { created_at: l.created_at } : {}),
    });
    updated.push(l.id);
  }
  for (const l of pending.values()) {
    if (taken.has(l.id)) continue; // a pinned copy — the operator owns it now
    lessons.push(l);
    added.push(l.id);
  }
  return { lessons, added, updated, removed };
}

/** Pure — the community lessons our own trades have not contradicted, and the ones they have. */
export function selectCommunityLessons(
  lessons: readonly Lesson[],
  history: readonly PerformanceRecord[],
): { usable: CommunityVerdict[]; withheld: CommunityVerdict[] } {
  const verdicts = lessons.filter(isCommunityBackup).map((l) => judgeCommunityLesson(l, history));
  return {
    usable: verdicts.filter((v) => v.status !== "contradicted"),
    withheld: verdicts.filter((v) => v.status === "contradicted"),
  };
}
