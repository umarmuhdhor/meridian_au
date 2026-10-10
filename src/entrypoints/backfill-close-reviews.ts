/**
 * One-off: re-run the close review for closes whose review came back empty because the
 * reviewer's 400-token budget was eaten by the reasoning model (fixed 2026-10-07). Fills
 * in what/why and writes the missing auto lesson; never re-scores the cited lessons.
 *
 *   node dist/entrypoints/backfill-close-reviews.js            # list targets only
 *   node dist/entrypoints/backfill-close-reviews.js --apply    # call the LLM and write
 *       --include-wins   also backfill empty WIN reviews (default: losses only)
 *       --limit N        stop after N records
 *       --redo backfilled|<pos,pos,…>
 *                        review these AGAIN even though not empty (`backfilled` = every review
 *                        an earlier backfill wrote); their old unpinned auto lesson is replaced
 *       --follow         instead: re-learn every follow-wallet lesson that has no MATCH yet
 *                        (written before 2026-10-07) from its mirror record
 *
 * Every proposed lesson must carry a MATCH condition that is backtested against past
 * trades (domain/rules/lesson-match.ts) — rules that would catch past trades of the
 * opposite outcome are rejected, so lessons stay narrow. Pinned lessons are never touched.
 *
 * Safe to run while the daemon is up: each record is a fresh load→mutate→save of
 * lessons.json, and lessons.json is backed up first.
 */
import "./load-env.js";

import { copyFile } from "node:fs/promises";
import path from "node:path";
import { systemClock } from "../ports/clock.js";
import type { LessonRepo } from "../ports/lesson-repo.js";
import type { LLMClient } from "../ports/llm-client.js";
import type { Logger } from "../ports/logger.js";
import { createConsoleLogger } from "../adapters/logger/console.js";
import { createJsonConfigRepo } from "../adapters/persistence/json/config-repo.js";
import { createJsonLessonRepo } from "../adapters/persistence/json/lesson-repo.js";
import { createJsonFollowRepo } from "../adapters/persistence/json/follow-repo.js";
import { createOpenRouterLLMClient } from "../adapters/llm/openrouter.js";
import { learnFromMirror, type RetrospectiveOutcome } from "../app/follow/learn.js";
import { backfillCloseReviews, pickBackfillable, type BackfillResult } from "../app/learning/close-review.js";

const REPO_ROOT = process.cwd();
const STATE_DIR = process.env.MERIDIAN_STATE_DIR ? path.resolve(process.env.MERIDIAN_STATE_DIR) : REPO_ROOT;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const includeWins = args.includes("--include-wins");
const followMode = args.includes("--follow");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const redoIdx = args.indexOf("--redo");
const redoArg = redoIdx >= 0 ? (args[redoIdx + 1] ?? "") : "";

const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

async function setupLlm(lessonsPath: string): Promise<{ llm: LLMClient; model: string }> {
  const cfg = await createJsonConfigRepo({ filePath: path.join(REPO_ROOT, "user-config.json") }).load();
  if (!cfg.ok) throw new Error("cannot load user-config.json");
  const model = process.env.LLM_MODEL ?? cfg.value.llm.managementModel;
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY / LLM_API_KEY not set");
  const llm = createOpenRouterLLMClient({
    apiKey,
    ...(process.env.LLM_BASE_URL ? { baseURL: process.env.LLM_BASE_URL } : {}),
  });
  const backup = `${lessonsPath}.bak-review-backfill-${Date.now()}`;
  await copyFile(lessonsPath, backup);
  console.log(`\nBackup: ${backup}\nModel: ${model}\n`);
  return { llm, model };
}

async function redoCloseReviews(lessons: LessonRepo, logger: Logger, lessonsPath: string): Promise<void> {
  const loaded = await lessons.load();
  if (!loaded.ok) throw new Error(`cannot read ${lessonsPath}`);
  const redo = new Set(
    redoArg === "backfilled"
      ? loaded.value.performance.filter((p) => p.review?.backfilled_at).map((p) => p.position)
      : redoArg.split(",").map((x) => x.trim()).filter(Boolean),
  );
  const followRepo = createJsonFollowRepo({ filePath: path.join(STATE_DIR, "follow-state.json"), logger });
  const mirrored = new Set((await followRepo.listMirrored()).map((m) => m.position));
  const targets = pickBackfillable(loaded.value.performance, includeWins, redo);
  console.log(`${targets.length} review(s) to (re)do in ${lessonsPath} (${redo.size} explicit redo)`);
  for (const t of targets) console.log(`  ${t.closed_at ?? "?"}  ${t.pool.padEnd(16)} ${sign(t.pnl_pct).padStart(8)}  ${t.position}`);

  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to call the LLM and fill them in.");
    return;
  }
  if (targets.length === 0) return;
  const { llm, model } = await setupLlm(lessonsPath);

  let done = 0;
  const results: BackfillResult[] = [];
  await backfillCloseReviews({
    lessons,
    llm,
    model,
    clock: systemClock,
    includeWins,
    redo,
    mirrored,
    stopAfter: limit,
    onResult: (r) => {
      results.push(r);
      done++;
      console.log(`[${done}/${Math.min(targets.length, limit)}] ${r.pool} ${sign(r.pnl_pct)} → ${r.status}`);
      if (r.what) console.log(`    WHAT: ${r.what}`);
      if (r.why) console.log(`    WHY:  ${r.why}`);
      if (r.lesson_rule) console.log(`    NEW LESSON ${r.lesson_id}: ${r.lesson_rule}`);
      if (r.rejected) console.log(`    rule rejected: ${r.rejected}`);
      if (r.replaced_lesson) console.log(`    removed old lesson ${r.replaced_lesson}`);
      if (r.error) console.log(`    error: ${r.error}`);
    },
  });

  const count = (s: BackfillResult["status"]) => results.filter((r) => r.status === s).length;
  console.log(
    `\nDone: ${count("lesson")} new lesson(s), ${count("no_lesson")} without a lesson, ` +
      `${count("too_broad")} rule rejected as too broad, ${count("failed")} failed (re-run to retry), ` +
      `${count("skipped")} skipped.`,
  );
}

/** Re-learn follow lessons written before the MATCH requirement, from their mirror records. */
async function redoFollowLessons(lessons: LessonRepo, logger: Logger, lessonsPath: string): Promise<void> {
  const followRepo = createJsonFollowRepo({ filePath: path.join(STATE_DIR, "follow-state.json"), logger });
  const mirrors = await followRepo.listMirrored();
  const loaded = await lessons.load();
  if (!loaded.ok) throw new Error(`cannot read ${lessonsPath}`);
  const targets = loaded.value.lessons
    .filter((l) => l.sourceType === "follow-retrospective" && !l.match && !l.pinned)
    .map((l) => ({ lesson: l, mirror: mirrors.find((m) => m.lesson_id === l.id) }))
    .slice(0, limit);
  console.log(`${targets.length} follow lesson(s) without MATCH`);
  for (const t of targets) {
    console.log(`  ${t.lesson.id}  ${t.mirror?.pool_name ?? "(mirror record gone — skipped)"}  ${t.lesson.rule.slice(0, 90)}`);
  }
  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }
  if (targets.length === 0) return;
  const { llm, model } = await setupLlm(lessonsPath);

  let n = 0;
  for (const t of targets) {
    n++;
    const mirror = t.mirror;
    if (!mirror) continue;
    const fresh = await lessons.load();
    const pnl = fresh.ok ? (fresh.value.performance.findLast((p) => p.position === mirror.position)?.pnl_pct ?? null) : null;
    let out: RetrospectiveOutcome | null = null;
    for (let i = 1; i <= 3 && !out; i++) {
      try {
        out = await learnFromMirror({ lessons, logger, clock: systemClock, llm, model }, mirror, pnl, {
          replaceLessonId: t.lesson.id,
          extraTags: ["backfill"],
        });
      } catch (e) {
        console.log(`    attempt ${i} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const status = !out ? "failed (old lesson kept)" : out.lessonId ? "lesson" : out.rejected ? "too_broad" : "no_lesson";
    console.log(`[${n}/${targets.length}] ${mirror.pool_name} ${pnl != null ? sign(pnl) : "?"} → ${status}`);
    if (!out) continue;
    if (out.rule) console.log(`    NEW LESSON ${out.lessonId}: ${out.rule}`);
    if (out.rejected) console.log(`    rule rejected: ${out.rejected}`);
    console.log(`    removed old lesson ${t.lesson.id}`);
    await followRepo.updateMirrored(mirror.position, { lesson_id: out.lessonId });
  }
}

async function main(): Promise<void> {
  const logger = createConsoleLogger("warn");
  const lessonsPath = path.join(STATE_DIR, "lessons.json");
  const lessons = createJsonLessonRepo({ filePath: lessonsPath, logger });
  if (followMode) await redoFollowLessons(lessons, logger, lessonsPath);
  else await redoCloseReviews(lessons, logger, lessonsPath);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
