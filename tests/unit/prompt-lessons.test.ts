import { describe, expect, it } from "vitest";
import type { Lesson } from "../../src/domain/schemas/lesson.js";
import {
  formatLessonsBlock,
  RECENT_UNPINNED_IN_PROMPT,
  selectPromptLessons,
  splitMatchedLessons,
} from "../../src/domain/prompt/lessons.js";
import { buildSystemPrompt } from "../../src/domain/prompt/builder.js";
import type { AppConfig } from "../../src/domain/schemas/config.js";

const L = (id: string, pinned: boolean, extra: Partial<Lesson> = {}): Lesson => ({
  id,
  rule: `rule ${id}`,
  tags: [],
  pinned,
  ...extra,
});

describe("selectPromptLessons", () => {
  it("keeps EVERY pinned lesson, newest first — not the oldest five", () => {
    // 12 pinned, oldest first in file order (lessons.json is append-only).
    const lessons = Array.from({ length: 12 }, (_, i) => L(`p${i}`, true));
    const sel = selectPromptLessons(lessons);
    expect(sel.pinned.map((l) => l.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `p${11 - i}`),
    );
  });

  it("keeps the newest pinned even when many unpinned came after it", () => {
    const lessons = [L("old-pin", true), ...Array.from({ length: 30 }, (_, i) => L(`u${i}`, false)), L("new-pin", true)];
    const sel = selectPromptLessons(lessons);
    expect(sel.pinned.map((l) => l.id)).toEqual(["new-pin", "old-pin"]);
  });

  it("limits unpinned to the newest N, newest first", () => {
    const lessons = Array.from({ length: 20 }, (_, i) => L(`u${i}`, false));
    const sel = selectPromptLessons(lessons);
    expect(sel.recent).toHaveLength(RECENT_UNPINNED_IN_PROMPT);
    expect(sel.recent[0]!.id).toBe("u19");
    expect(selectPromptLessons(lessons, { recent: 2 }).recent.map((l) => l.id)).toEqual(["u19", "u18"]);
  });
});

describe("formatLessonsBlock", () => {
  it("renders ids so the screener can cite them, plus the W/L track record", () => {
    const text = formatLessonsBlock(
      selectPromptLessons([
        L("l-a", true, { stats: { applied: 5, wins: 2, losses: 3 } }),
        L("l-b", false),
      ]),
    );
    expect(text).toContain("[l-a] rule l-a  (applied 5x → 2W/3L)");
    expect(text).toContain("[l-b] rule l-b");
    expect(text).not.toContain("[l-b] rule l-b  (applied");
    expect(text.indexOf("PINNED")).toBeLessThan(text.indexOf("RECENT"));
  });

  it("is empty when there are no lessons", () => {
    expect(formatLessonsBlock(selectPromptLessons([]))).toBe("");
  });
});

describe("buildSystemPrompt LESSONS block", () => {
  it("includes all pinned lessons and the curve ban", () => {
    const lessons = Array.from({ length: 9 }, (_, i) => L(`p${i}`, true));
    const prompt = buildSystemPrompt({
      role: "SCREENER",
      wallet: { sol: 1, sol_usd: 150, sol_price: 150 } as never,
      positions: { total_positions: 0, positions: [] } as never,
      config: { risk: { maxPositions: 3 } } as unknown as AppConfig,
      lessons,
    });
    for (let i = 0; i < 9; i++) expect(prompt).toContain(`[p${i}]`);
    expect(prompt).toContain("curve is FORBIDDEN");
    expect(prompt).toContain("lessons_applied");
  });
});

describe("splitMatchedLessons", () => {
  it("moves unpinned MATCH lessons out of the general block; pinned ones stay", () => {
    const ls = [
      { id: "plain", rule: "r", tags: [], pinned: false },
      { id: "auto", rule: "r", tags: [], pinned: false, match: "1h.trend = DOWN AND mcap < 1" },
      { id: "pinned-auto", rule: "r", tags: [], pinned: true, match: "1h.trend = DOWN AND mcap < 1" },
    ] as Lesson[];
    const s = splitMatchedLessons(ls);
    expect(s.general.map((l) => l.id)).toEqual(["plain", "pinned-auto"]);
    expect(s.matched.map((l) => l.id)).toEqual(["auto", "pinned-auto"]);
  });
});
