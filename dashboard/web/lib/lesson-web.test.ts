import { describe, it, expect } from "vitest";
import { buildLessonWeb, conclude, evidenceFor, groupOf, layoutWeb, lean, labelBox, labelWidth, partnerCounts, strength, type ConceptNode } from "./lesson-web";

const L = (id: string, side: "PREFER" | "AVOID", match: string, extra: Record<string, unknown> = {}) => ({
  id,
  rule: `[auto X] ${side} spot when ${match} — because. {applies ONLY when: ${match} — history 1W/0L}`,
  match,
  sourceType: "close-review",
  ...extra,
});

const lessons = [
  L("a", "AVOID", "fee_tvl_ratio < 0.3 AND 15m.from_high > -10", { context: { pool_name: "RARI-SOL", pnl_pct: -19 } }),
  L("b", "AVOID", "fee_tvl_ratio < 0.35 AND 1h.vol_x < 0.5"),
  L("c", "PREFER", "1h.vol_x > 3 AND 1h.from_high > -5"),
  { id: "m", rule: "EXTREME VOL VETO: NO DEPLOY when 1h ATR > 25%" },
];

describe("buildLessonWeb", () => {
  const web = buildLessonWeb(lessons);

  it("keeps only condition-matched lessons and counts the rest", () => {
    expect(web.lessons.map((l) => [l.id, l.side])).toEqual([["a", "HINDARI"], ["b", "HINDARI"], ["c", "ULANGI"]]);
    expect(web.freeText).toBe(1);
    expect(web.lessons[0]!.pool).toBe("RARI-SOL");
  });

  it("merges timeframes into one concept node and tallies sides", () => {
    const near = web.concepts.find((c) => c.key === "from_high:high")!;
    expect(near).toMatchObject({ label: "Masih dekat puncak", repeat: 1, avoid: 1, total: 2, tfs: ["1 jam", "15 menit"] });
    const fee = web.concepts.find((c) => c.key === "fee_tvl_ratio:low")!;
    expect(fee).toMatchObject({ repeat: 0, avoid: 2, lessons: ["a", "b"] });
    expect(web.concepts[0]!.total).toBe(2); // sorted by usage
  });

  it("threads concepts that share a lesson", () => {
    const e = web.edges.find((x) => x.a === "fee_tvl_ratio:low" && x.b === "from_high:high");
    expect(e?.count).toBe(1);
    expect(web.edges).toHaveLength(3);
  });

  it("concludes per concept", () => {
    const fee = web.concepts.find((c) => c.key === "fee_tvl_ratio:low")!;
    expect(conclude(fee, web).tone).toBe("loss");
    expect(conclude(fee, web).withAvoid).toEqual(["Masih dekat puncak", "Volume sepi"]);
    const near = web.concepts.find((c) => c.key === "from_high:high")!;
    const c = conclude(near, web);
    expect(c.tone).toBe("mixed");
    expect(c.withRepeat).toEqual(["Volume ramai"]);
    expect(c.withAvoid).toEqual(["Fee pool kecil"]);
    expect(lean(near)).toBe(0);
  });

  it("groups concepts and summarises their evidence", () => {
    const fee = web.concepts.find((c) => c.key === "fee_tvl_ratio:low")!;
    const near = web.concepts.find((c) => c.key === "from_high:high")!;
    const loud = web.concepts.find((c) => c.key === "vol_x:high")!;
    expect([groupOf(fee), groupOf(near), groupOf(loud)]).toEqual(["loss", "mixed", "weak"]);
    expect([strength(fee), strength(loud)]).toEqual(["sedang", "lemah"]);
    expect(partnerCounts(fee, web, "HINDARI")).toEqual([
      { key: "from_high:high", label: "Masih dekat puncak", count: 1 },
      { key: "vol_x:low", label: "Volume sepi", count: 1 },
    ]);
    expect(evidenceFor(fee, web).avgPnl).toEqual({ ULANGI: null, HINDARI: -19 });
  });

  it("lays HINDARI concepts out on the left, ULANGI on the right", () => {
    const lay = layoutWeb(web.concepts, 1000, 600);
    const x = (k: string) => lay.nodes.get(k)!.x;
    expect(x("fee_tvl_ratio:low")).toBeLessThan(500);
    expect(x("vol_x:high")).toBeGreaterThan(500);
    expect(lay.nodes.size).toBe(web.concepts.length);
    expect(lay.hubs.HINDARI.x).toBeLessThan(lay.hubs.ULANGI.x);
  });

  it("keeps labels from overlapping even when crowded", () => {
    const many: ConceptNode[] = Array.from({ length: 26 }, (_, i) => ({
      key: `k${i}`,
      label: i % 3 ? "Harga tidak sedang melonjak" : "Fee pool kecil",
      repeat: i % 4,
      avoid: (i + 1) % 3,
      total: (i % 4) + ((i + 1) % 3) || 1,
      tfs: [],
      lessons: [],
    }));
    const lay = layoutWeb(many, 1000, 640);
    const boxes = many.map((c) => labelBox(lay.nodes.get(c.key)!, labelWidth(c)));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i]!;
        const B = boxes[j]!;
        const overlap = A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 - 0.5 && B.y0 < A.y1 - 0.5;
        expect(overlap, `${i} vs ${j}`).toBe(false);
      }
  });
});

