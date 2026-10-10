import { describe, expect, it } from "vitest";
import type { Lesson, PerformanceRecord } from "../../src/domain/schemas/lesson.js";
import {
  COMMUNITY_SOURCE,
  isCommunityBackup,
  judgeCommunityLesson,
  mergeCommunityLessons,
  MIN_OWN_TRADES,
  selectCommunityLessons,
} from "../../src/domain/rules/community-lessons.js";
import { formatCommunityBlock, selectPromptLessons, splitMatchedLessons } from "../../src/domain/prompt/lessons.js";
import { candidateAsRecord, lessonsForCandidate, parseMatch } from "../../src/domain/rules/lesson-match.js";

const THIN = "tvl < 20000 AND mcap < 1000000";

const community = (id: string, extra: Partial<Lesson> = {}): Lesson => ({
  id,
  rule: `community rule ${id}`,
  tags: ["community"],
  pinned: false,
  sourceType: COMMUNITY_SOURCE,
  outcome: "loss",
  ...extra,
});

const own = (id: string, extra: Partial<Lesson> = {}): Lesson => ({ id, rule: `own rule ${id}`, tags: [], pinned: false, ...extra });

const trade = (i: number, pnl_pct: number, over: Partial<PerformanceRecord> = {}): PerformanceRecord =>
  ({ position: `pos${i}`, pnl_pct, close_reason: "x", recorded_at: "2026-10-10T00:00:00Z", ...over }) as PerformanceRecord;

/** `n` thin-pool trades at `thinPnl` plus 20 deep-pool trades at +2%. */
function history(n: number, thinPnl: number): PerformanceRecord[] {
  return [
    ...Array.from({ length: n }, (_, i) => trade(i, thinPnl, { entry_tvl: 15_000, entry_mcap: 500_000 })),
    ...Array.from({ length: 20 }, (_, i) => trade(100 + i, 2, { entry_tvl: 80_000, entry_mcap: 3_000_000 })),
  ];
}

describe("judgeCommunityLesson", () => {
  it("is untested until enough of our own trades fall in its bucket", () => {
    const v = judgeCommunityLesson(community("c1", { match: THIN }), history(MIN_OWN_TRADES - 1, -10));
    expect(v.status).toBe("untested");
    expect(v.own).toContain(`${MIN_OWN_TRADES - 1} of our trades match`);
  });

  it("records without entry_tvl never match — old history leaves a tvl lesson untested", () => {
    const old = Array.from({ length: 30 }, (_, i) => trade(i, -5, { entry_mcap: 500_000 }));
    expect(judgeCommunityLesson(community("c1", { match: THIN }), old).status).toBe("untested");
  });

  it("a caution is supported when our trades in its bucket did worse than our average", () => {
    const v = judgeCommunityLesson(community("c1", { match: THIN }), history(MIN_OWN_TRADES, -6));
    expect(v.status).toBe("supported");
  });

  it("a caution is contradicted when our trades in its bucket did at least as well", () => {
    const v = judgeCommunityLesson(community("c1", { match: THIN }), history(MIN_OWN_TRADES, 5));
    expect(v.status).toBe("contradicted");
  });

  it("a PREFER lesson reads the same evidence the other way round", () => {
    const prefer = community("c1", { match: THIN, outcome: "win" });
    expect(judgeCommunityLesson(prefer, history(MIN_OWN_TRADES, 5)).status).toBe("supported");
    expect(judgeCommunityLesson(prefer, history(MIN_OWN_TRADES, -6)).status).toBe("contradicted");
  });

  it("a caution our deploys kept winning despite is contradicted by its track record", () => {
    const v = judgeCommunityLesson(community("c1", { stats: { applied: 4, wins: 3, losses: 1 } }), []);
    expect(v.status).toBe("contradicted");
    expect(v.own).toContain("3W/1L");
  });

  it("ignores a track record shorter than the minimum", () => {
    const v = judgeCommunityLesson(community("c1", { stats: { applied: 2, wins: 2, losses: 0 } }), []);
    expect(v.status).toBe("untested");
  });

  it("an unparseable MATCH never reaches the prompt", () => {
    expect(judgeCommunityLesson(community("c1", { match: "tvl < 20000" }), []).status).toBe("contradicted");
  });
});

describe("community lessons stay out of our own lesson slots", () => {
  const lessons = [own("o1"), community("c-general"), community("c-matched", { match: THIN }), own("o2", { match: THIN })];

  it("selectPromptLessons never puts an unpinned community lesson in RECENT", () => {
    expect(selectPromptLessons(lessons).recent.map((l) => l.id)).toEqual(["o2", "o1"]);
  });

  it("splitMatchedLessons keeps them out of both the general block and the per-candidate own hits", () => {
    const { general, matched } = splitMatchedLessons(lessons);
    expect(general.map((l) => l.id)).toEqual(["o1"]);
    expect(matched.map((l) => l.id)).toEqual(["o2"]);
  });

  it("a pinned community lesson is the operator promoting it — it becomes an own lesson", () => {
    const pinned = community("c-pin", { pinned: true });
    expect(isCommunityBackup(pinned)).toBe(false);
    expect(selectPromptLessons([pinned]).pinned.map((l) => l.id)).toEqual(["c-pin"]);
  });

  it("selectCommunityLessons withholds what our trades contradict", () => {
    const sel = selectCommunityLessons(
      [community("keep", { match: THIN }), community("drop", { stats: { applied: 3, wins: 3, losses: 0 } }), own("o1")],
      history(MIN_OWN_TRADES, -6),
    );
    expect(sel.usable.map((v) => v.lesson.id)).toEqual(["keep"]);
    expect(sel.withheld.map((v) => v.lesson.id)).toEqual(["drop"]);
  });

  it("formatCommunityBlock renders only the MATCH-less ones, under the precedence guide", () => {
    const sel = selectCommunityLessons(lessons, []);
    const text = formatCommunityBlock(sel.usable);
    expect(text).toContain("Our own LESSONS and history always win");
    expect(text).toContain("[c-general]");
    expect(text).not.toContain("[c-matched]");
    expect(formatCommunityBlock([])).toBe("");
  });
});

describe("mergeCommunityLessons", () => {
  it("adds new, updates listed (keeping earned stats), removes unlisted — never touches own or pinned", () => {
    const stats = { applied: 3, wins: 1, losses: 2 };
    const existing = [
      own("o1"),
      community("c-keep", { rule: "old text", stats, created_at: "2026-10-01" }),
      community("c-gone"),
      community("c-pinned", { pinned: true, rule: "operator edited" }),
    ];
    const incoming = [
      community("c-keep", { rule: "new text", created_at: "2026-10-10" }),
      community("c-new"),
      community("c-pinned", { rule: "catalog text" }),
    ];
    const out = mergeCommunityLessons(existing, incoming);
    expect(out.added).toEqual(["c-new"]);
    expect(out.updated).toEqual(["c-keep"]);
    expect(out.removed).toEqual(["c-gone"]);
    const byId = new Map(out.lessons.map((l) => [l.id, l]));
    expect(byId.get("c-keep")).toMatchObject({ rule: "new text", stats, created_at: "2026-10-01" });
    expect(byId.get("c-pinned")?.rule).toBe("operator edited");
    expect(byId.has("o1")).toBe(true);
  });
});

describe("tvl in MATCH conditions", () => {
  it("parses tvl and evaluates it against a candidate's pool TVL", () => {
    expect(parseMatch(THIN).ok).toBe(true);
    const thin = candidateAsRecord({ tvl: 15_000, mcap: 500_000 });
    const deep = candidateAsRecord({ tvl: 60_000, mcap: 500_000 });
    const lesson = community("c1", { match: THIN });
    expect(lessonsForCandidate([lesson], thin)).toHaveLength(1);
    expect(lessonsForCandidate([lesson], deep)).toHaveLength(0);
  });
});
