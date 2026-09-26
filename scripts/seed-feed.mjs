/**
 * Bulk-seed the Feed (lessons + strategy library) from one editable JSON file,
 * instead of one modal per lesson in the dashboard.
 *
 *   node scripts/seed-feed.mjs                       # uses deploy/homeserver/feed-seed.json
 *   node scripts/seed-feed.mjs --dry-run             # show what would change, write nothing
 *   node scripts/seed-feed.mjs path/to/other.json
 *
 * No daemon restart needed: the lesson + strategy repos re-read their file on
 * every call, so the next screening cycle already sees what this writes.
 *
 * Writes are temp-file + rename (atomic, crash-safe). These live in the state
 * DIRECTORY, so rename is the right primitive here -- unlike user-config.json,
 * which is a single-file bind mount in Docker and needs an in-place write.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(REPO_ROOT, ".env"), quiet: true });

const STATE_DIR = process.env.MERIDIAN_STATE_DIR || REPO_ROOT;
const DRY = process.argv.includes("--dry-run");
const seedPath = path.resolve(
  process.argv.slice(2).find((a) => !a.startsWith("--")) ??
    path.join(REPO_ROOT, "deploy", "homeserver", "feed-seed.json"),
);

// Identical to src/app/tools/impls/add-lesson.ts: collapse whitespace, cap at
// 500. Deliberately does NOT strip `<` / `>` -- lessons render into LLM prompts,
// never HTML, and the comparators carry meaning ("1h ATR > 25%").
const MAX_LEN = 500;
const sanitize = (t) => t.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
const norm = (t) => sanitize(t).toLowerCase();

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`FATAL: ${file} is not valid JSON (${e.message}). Nothing written.`);
    process.exit(1);
  }
}

function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

if (!existsSync(seedPath)) {
  console.error(`FATAL: seed file not found: ${seedPath}`);
  process.exit(1);
}
const seed = readJson(seedPath, null);
if (!seed || typeof seed !== "object") {
  console.error("FATAL: seed file must be a JSON object.");
  process.exit(1);
}

console.log(`seed  : ${seedPath}`);
console.log(`state : ${STATE_DIR}`);
console.log(DRY ? "mode  : DRY RUN (tidak menulis apa pun)\n" : "mode  : WRITE\n");

// ---------------------------------------------------------------- lessons ---
const lessonsFile = path.join(STATE_DIR, "lessons.json");
const lessonDoc = readJson(lessonsFile, { lessons: [], performance: [] });
lessonDoc.lessons ??= [];
lessonDoc.performance ??= []; // never touched here, but must survive the rewrite

const existing = new Set(lessonDoc.lessons.map((l) => norm(l.rule ?? "")));
const seedLessons = Array.isArray(seed.lessons) ? seed.lessons : [];
let stamp = Date.now();
let added = 0;
let skipped = 0;

for (const raw of seedLessons) {
  const item = typeof raw === "string" ? { rule: raw } : raw;
  const rule = sanitize(String(item?.rule ?? ""));
  if (rule.length < 3) {
    console.log(`  SKIP (terlalu pendek): ${JSON.stringify(item?.rule ?? "")}`);
    skipped++;
    continue;
  }
  if (existing.has(norm(rule))) {
    console.log(`  SKIP (sudah ada)     : ${rule.slice(0, 70)}`);
    skipped++;
    continue;
  }
  existing.add(norm(rule));
  lessonDoc.lessons.push({
    id: `l-${stamp++}`, // matches add_lesson's `l-<epoch ms>`; incremented so a batch stays unique
    rule,
    tags: Array.isArray(item.tags) ? item.tags : [],
    role: item.role ?? null,
    pinned: item.pinned === true,
    sourceType: "manual",
    created_at: new Date().toISOString(),
  });
  added++;
  const flag = item.pinned === true ? " [PINNED]" : "";
  console.log(`  ADD${flag.padEnd(9)}: ${rule.slice(0, 70)}`);
}

// -------------------------------------------------------------- strategies ---
const stratFile = path.join(STATE_DIR, "strategy-library.json");
const stratDoc = readJson(stratFile, { active: "custom_ratio_spot", strategies: {} });
stratDoc.strategies ??= {};
const seedStrats = Array.isArray(seed.strategies) ? seed.strategies : [];
let stratsWritten = 0;

for (const s of seedStrats) {
  if (!s?.id || !s?.name || !s?.lp_strategy) {
    console.log(`  SKIP strategi (butuh id + name + lp_strategy): ${JSON.stringify(s)}`);
    continue;
  }
  // Every nullable field must be present -- StrategyEntrySchema defaults them to
  // null, but an absent key in a hand-written file reads as a silent omission.
  stratDoc.strategies[s.id] = {
    id: s.id,
    name: s.name,
    author: s.author ?? null,
    lp_strategy: s.lp_strategy,
    token_criteria: s.token_criteria ?? null,
    entry: s.entry ?? null,
    range: s.range ?? null,
    exit: s.exit ?? null,
    best_for: s.best_for ?? null,
    raw: s.raw ?? null,
  };
  stratsWritten++;
  console.log(`  STRATEGY: ${s.id} (${s.name})`);
}

if (seed.activeStrategy) {
  if (!stratDoc.strategies[seed.activeStrategy]) {
    console.error(
      `FATAL: activeStrategy "${seed.activeStrategy}" tidak ada di strategies. Nothing written.`,
    );
    process.exit(1);
  }
  stratDoc.active = seed.activeStrategy;
  console.log(`  ACTIVE  : ${seed.activeStrategy}`);
}

// ------------------------------------------------------------------ commit ---
console.log(
  `\nlessons: +${added} baru, ${skipped} dilewati, total ${lessonDoc.lessons.length}` +
    ` | strategies: ${stratsWritten} ditulis, total ${Object.keys(stratDoc.strategies).length}`,
);

if (DRY) {
  console.log("\nDRY RUN - tidak ada file yang diubah.");
  process.exit(0);
}
if (added > 0) writeJsonAtomic(lessonsFile, lessonDoc);
if (stratsWritten > 0 || seed.activeStrategy) writeJsonAtomic(stratFile, stratDoc);
console.log(`\nwrote ${lessonsFile}`);
if (stratsWritten > 0 || seed.activeStrategy) console.log(`wrote ${stratFile}`);
console.log("Tidak perlu restart - repo membaca file ini tiap siklus.");
