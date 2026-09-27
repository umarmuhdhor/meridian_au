import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { createJsonLessonRepo } from "../../src/adapters/persistence/json/lesson-repo.js";
import { nullLogger } from "../../src/ports/logger.js";
import { mkTmpDir, rmDir } from "./tmpdir.js";

const created: string[] = [];
afterEach(async () => {
  while (created.length) {
    const d = created.pop();
    if (d) await rmDir(d);
  }
});

describe("JsonLessonRepo", () => {
  it("empty on missing file", async () => {
    const dir = await mkTmpDir("les-empty");
    created.push(dir);
    const repo = createJsonLessonRepo({ filePath: path.join(dir, "l.json"), logger: nullLogger });
    const r = await repo.load();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lessons).toEqual([]);
      expect(r.value.performance).toEqual([]);
    }
  });

  it("addLesson + listLessons + pin/unpin round-trip", async () => {
    const dir = await mkTmpDir("les-rw");
    created.push(dir);
    const repo = createJsonLessonRepo({ filePath: path.join(dir, "l.json"), logger: nullLogger });
    await repo.addLesson({ id: "l1", rule: "prefer high fee/TVL", tags: ["screening"], pinned: false });
    await repo.addLesson({ id: "l2", rule: "avoid low organic", tags: ["screening"], pinned: false });
    const all = await repo.listLessons();
    expect(all.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(await repo.pinLesson("l1")).toBe(true);
    const pinned = await repo.listLessons({ pinned: true });
    expect(pinned.map((l) => l.id)).toEqual(["l1"]);
    expect(await repo.unpinLesson("l1")).toBe(true);
    expect((await repo.listLessons({ pinned: true })).length).toBe(0);
    expect(await repo.pinLesson("nope")).toBe(false);
  });

  it("appendPerformance stores + recentPerformance returns tail", async () => {
    const dir = await mkTmpDir("les-perf");
    created.push(dir);
    const repo = createJsonLessonRepo({ filePath: path.join(dir, "l.json"), logger: nullLogger });
    for (let i = 0; i < 5; i += 1) {
      await repo.appendPerformance({
        position: `p${i}`,
        pnl_pct: i,
        close_reason: "test",
        recorded_at: `2026-07-05T${String(i).padStart(2, "0")}:00:00.000Z`,
      });
    }
    const tail = await repo.recentPerformance(2);
    expect(tail.map((p) => p.position)).toEqual(["p3", "p4"]);
  });
  it("updatePerformance merges into the matching record and reports misses", async () => {
    const dir = await mkTmpDir("les-upd");
    created.push(dir);
    const repo = createJsonLessonRepo({ filePath: path.join(dir, "l.json"), logger: nullLogger });
    const base = { pnl_pct: 1, close_reason: "x", recorded_at: "2026-09-27T00:00:00.000Z" };
    await repo.appendPerformance({ ...base, position: "A", pnl_usd: -0.95, fees_earned_usd: 0.37 });
    await repo.appendPerformance({ ...base, position: "B", pnl_usd: 5 });

    expect(await repo.updatePerformance("A", { pnl_usd: -1.22, fees_earned_usd: 4.56, pnl_source: "meteora_closed" })).toBe(true);
    expect(await repo.updatePerformance("missing", { pnl_usd: 0 })).toBe(false);

    const recs = await repo.recentPerformance();
    expect(recs.find((r) => r.position === "A")).toMatchObject({ pnl_usd: -1.22, fees_earned_usd: 4.56, pnl_source: "meteora_closed", close_reason: "x" });
    expect(recs.find((r) => r.position === "B")?.pnl_usd).toBe(5);
  });
});
