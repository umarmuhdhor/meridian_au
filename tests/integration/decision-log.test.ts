import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { createJsonDecisionLog } from "../../src/adapters/persistence/json/decision-log.js";
import { nullLogger } from "../../src/ports/logger.js";
import { mkTmpDir, rmDir } from "./tmpdir.js";

const created: string[] = [];
afterEach(async () => {
  while (created.length) {
    const d = created.pop();
    if (d) await rmDir(d);
  }
});

describe("JsonDecisionLog", () => {
  it("empty on missing file", async () => {
    const dir = await mkTmpDir("dec-empty");
    created.push(dir);
    const repo = createJsonDecisionLog({ filePath: path.join(dir, "d.json"), logger: nullLogger });
    const r = await repo.load();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.decisions).toEqual([]);
  });

  it("append prepends and keeps every entry (no cap)", async () => {
    const dir = await mkTmpDir("dec-cap");
    created.push(dir);
    const repo = createJsonDecisionLog({ filePath: path.join(dir, "d.json"), logger: nullLogger });
    for (let i = 0; i < 105; i += 1) {
      await repo.append({
        id: `d${i}`,
        ts: `2026-07-05T12:${String(i % 60).padStart(2, "0")}:00.000Z`,
        type: "note",
        actor: "GENERAL",
        pool: null,
        pool_name: null,
        summary: `entry ${i}`,
        reason: null,
        risks: [],
        metrics: {},
        rejected: [],
      });
    }
    const recent = await repo.recent(10);
    expect(recent).toHaveLength(10);
    expect(recent[0]?.id).toBe("d104");
    const all = await repo.recent(200);
    expect(all).toHaveLength(105);
    expect(all[104]?.id).toBe("d0");
  });
});
