/**
 * Import the curated community-lesson catalog (lessons other operators' bots learned, from
 * the Meridian Telegram group — see scripts/tg-scrape) into lessons.json as BACKUP lessons.
 *
 *   npx tsx src/entrypoints/import-community-lessons.ts            # dry run: verdicts + diff
 *   npx tsx src/entrypoints/import-community-lessons.ts --write    # back up lessons.json, then write
 *       --file <path>   catalog (default data/tg-scrape/community-lessons.json, gitignored —
 *                       the repo is public and the curated lessons are trading edge)
 *
 * Only catalog entries with status "backup" are imported; "covered" and "rejected" entries
 * document why the rest of the group's lessons were not. How backup lessons reach the
 * screener, and how our own trades overrule them, is in domain/rules/community-lessons.ts.
 *
 * Run it only against a daemon built WITH community-lesson support: an older build treats
 * them as ordinary lessons (they would take RECENT slots). Safe while that daemon is up —
 * one load→mutate→save of lessons.json, which is backed up first.
 */
import "./load-env.js";

import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { systemClock } from "../ports/clock.js";
import { createConsoleLogger } from "../adapters/logger/console.js";
import { createJsonLessonRepo } from "../adapters/persistence/json/lesson-repo.js";
import type { Lesson } from "../domain/schemas/lesson.js";
import { parseMatch } from "../domain/rules/lesson-match.js";
import {
  COMMUNITY_SOURCE,
  judgeCommunityLesson,
  mergeCommunityLessons,
} from "../domain/rules/community-lessons.js";

const REPO_ROOT = process.cwd();
const STATE_DIR = process.env.MERIDIAN_STATE_DIR ? path.resolve(process.env.MERIDIAN_STATE_DIR) : REPO_ROOT;

const args = process.argv.slice(2);
const write = args.includes("--write");
const fileIdx = args.indexOf("--file");
const catalogPath = path.resolve(
  REPO_ROOT,
  fileIdx >= 0 ? (args[fileIdx + 1] ?? "") : "data/tg-scrape/community-lessons.json",
);

const EntrySchema = z
  .object({
    id: z.string().regex(/^c-[a-z0-9-]+$/, "ids are c-<kebab-case>"),
    status: z.enum(["backup", "covered", "rejected"]),
    rule: z.string().min(10).max(500),
    outcome: z.enum(["win", "loss"]).optional(),
    match: z.string().optional(),
    evidence: z.string(),
    /** For covered/rejected entries: why it is not imported. */
    verdict: z.string().optional(),
  })
  .refine((e) => e.status !== "backup" || e.outcome, { message: "backup entries need an outcome" });

const CatalogSchema = z.object({
  source: z.string(),
  scraped_until: z.string(),
  lessons: z.array(EntrySchema),
});

async function main(): Promise<void> {
  const catalog = CatalogSchema.parse(JSON.parse(await readFile(catalogPath, "utf8")));
  const now = systemClock.now().toISOString();

  const incoming: Lesson[] = [];
  for (const e of catalog.lessons) {
    if (e.status !== "backup") continue;
    if (e.match) {
      const parsed = parseMatch(e.match);
      if (!parsed.ok) throw new Error(`${e.id}: MATCH invalid — ${parsed.error}`);
    }
    incoming.push({
      id: e.id,
      rule: e.rule,
      tags: ["community"],
      pinned: false,
      sourceType: COMMUNITY_SOURCE,
      outcome: e.outcome ?? null,
      ...(e.match ? { match: e.match } : {}),
      context: { source: catalog.source, scraped_until: catalog.scraped_until, evidence: e.evidence },
      created_at: now,
    });
  }

  const lessonsPath = path.join(STATE_DIR, "lessons.json");
  const repo = createJsonLessonRepo({ filePath: lessonsPath, logger: createConsoleLogger("warn") });
  const loaded = await repo.load();
  if (!loaded.ok) throw new Error(`cannot read ${lessonsPath}`);
  const history = loaded.value.performance;

  console.log(`Catalog: ${catalogPath}\nSource: ${catalog.source} (until ${catalog.scraped_until})`);
  console.log(`Judged against ${history.length} of our closed trades.\n`);
  for (const status of ["backup", "covered", "rejected"] as const) {
    const group = catalog.lessons.filter((e) => e.status === status);
    if (!group.length) continue;
    console.log(`── ${status.toUpperCase()} (${group.length}) ──`);
    for (const e of group) {
      if (status === "backup") {
        const lesson = incoming.find((l) => l.id === e.id)!;
        const v = judgeCommunityLesson(lesson, history);
        console.log(`  [${e.id}] ${v.status.toUpperCase()}${e.match ? `  MATCH ${e.match}` : ""}\n      ${v.own}`);
      } else {
        console.log(`  [${e.id}] ${e.verdict ?? ""}`);
      }
    }
    console.log("");
  }

  const merged = mergeCommunityLessons(loaded.value.lessons, incoming);
  console.log(`lessons.json: +${merged.added.length} added, ${merged.updated.length} updated, -${merged.removed.length} removed`);
  if (merged.removed.length) console.log(`  removed: ${merged.removed.join(", ")}`);

  if (!write) {
    console.log("\nDry run — nothing written. Re-run with --write to apply.");
    return;
  }
  const backup = `${lessonsPath}.bak-community-${Date.now()}`;
  await copyFile(lessonsPath, backup);
  // Re-read right before saving so a lesson the daemon wrote meanwhile is not lost.
  const fresh = await repo.load();
  if (!fresh.ok) throw new Error(`cannot re-read ${lessonsPath}`);
  const final = mergeCommunityLessons(fresh.value.lessons, incoming);
  await repo.save({ ...fresh.value, lessons: final.lessons });
  console.log(`\nWritten. Backup: ${backup}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
