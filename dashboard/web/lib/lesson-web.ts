// "Jaring kesimpulan": every condition-matched lesson (auto close review + follow retrospective)
// broken into its timeframe-free concepts. A concept used by several lessons becomes a hub; two
// concepts in the same lesson get a thread between them. Free-text (manual) lessons can't be
// broken down, so they are counted but not drawn.

import { plainLesson, type PlainLesson } from "./lesson-plain";

export type Side = "ULANGI" | "HINDARI";

export interface WebLessonInput {
  id: string;
  rule: string;
  match?: string | null;
  pinned?: boolean;
  sourceType?: string | null;
  created_at?: string;
  stats?: { applied: number; wins: number; losses: number };
  context?: Record<string, unknown> | null;
}

export interface WebLesson {
  id: string;
  side: Side;
  plain: PlainLesson;
  concepts: string[];
  source: "review" | "follow";
  pool: string | null;
  pnl: number | null;
  created_at?: string;
  stats?: WebLessonInput["stats"];
}

export interface ConceptNode {
  key: string;
  label: string;
  repeat: number;
  avoid: number;
  total: number;
  /** Timeframes the concept was seen on ("15 menit", "1 jam"). */
  tfs: string[];
  lessons: string[];
}

export interface ConceptEdge {
  a: string;
  b: string;
  count: number;
}

export interface LessonWeb {
  lessons: WebLesson[];
  concepts: ConceptNode[];
  edges: ConceptEdge[];
  /** Lessons without a MATCH (manual / older) — listed, not drawn. */
  freeText: number;
}

export function buildLessonWeb(input: readonly WebLessonInput[]): LessonWeb {
  const lessons: WebLesson[] = [];
  let freeText = 0;
  for (const l of input) {
    const plain = plainLesson(l.rule, l.match);
    if (!plain.action || !plain.conditions.length) {
      freeText += 1;
      continue;
    }
    const ctx = l.context ?? {};
    lessons.push({
      id: String(l.id),
      side: plain.action,
      plain,
      concepts: [...new Set(plain.conditions.map((c) => c.concept.key))],
      source: l.sourceType === "close-review" ? "review" : "follow",
      pool: typeof ctx.pool_name === "string" ? ctx.pool_name : null,
      pnl: typeof ctx.pnl_pct === "number" ? ctx.pnl_pct : null,
      created_at: l.created_at,
      stats: l.stats,
    });
  }

  const nodes = new Map<string, ConceptNode & { tfSet: Set<string> }>();
  const edges = new Map<string, ConceptEdge>();
  for (const l of lessons) {
    for (const c of l.plain.conditions) {
      const k = c.concept.key;
      let n = nodes.get(k);
      if (!n) {
        n = { key: k, label: c.concept.label, repeat: 0, avoid: 0, total: 0, tfs: [], lessons: [], tfSet: new Set() };
        nodes.set(k, n);
      }
      if (c.concept.tf) n.tfSet.add(c.concept.tf);
      if (!n.lessons.includes(l.id)) {
        n.lessons.push(l.id);
        n.total += 1;
        if (l.side === "ULANGI") n.repeat += 1;
        else n.avoid += 1;
      }
    }
    const ks = [...l.concepts].sort();
    for (let i = 0; i < ks.length; i++)
      for (let j = i + 1; j < ks.length; j++) {
        const id = `${ks[i]}|${ks[j]}`;
        const e = edges.get(id) ?? { a: ks[i]!, b: ks[j]!, count: 0 };
        e.count += 1;
        edges.set(id, e);
      }
  }

  const concepts = [...nodes.values()]
    .map(({ tfSet, ...n }) => ({ ...n, tfs: [...tfSet].sort() }))
    .sort((x, y) => y.total - x.total || x.label.localeCompare(y.label));
  return { lessons, concepts, edges: [...edges.values()], freeText };
}

/** -1 = only in HINDARI rules, +1 = only in ULANGI rules. */
export const lean = (c: Pick<ConceptNode, "repeat" | "avoid" | "total">) => (c.total ? (c.repeat - c.avoid) / c.total : 0);

export interface Conclusion {
  tone: "profit" | "loss" | "mixed";
  text: string;
  /** For mixed concepts: what it appeared with when the rule said ULANGI vs HINDARI. */
  withRepeat: string[];
  withAvoid: string[];
}

export function conclude(c: ConceptNode, web: LessonWeb): Conclusion {
  const label = (k: string) => web.concepts.find((n) => n.key === k)?.label ?? k;
  const partners = (side: Side) => {
    const count = new Map<string, number>();
    for (const l of web.lessons)
      if (l.side === side && l.concepts.includes(c.key))
        for (const k of l.concepts) if (k !== c.key) count.set(k, (count.get(k) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => label(k));
  };
  if (c.avoid === 0) {
    return {
      tone: "profit",
      text:
        c.repeat === 1
          ? `Baru sekali muncul, di aturan ULANGI. Belum cukup bukti untuk jadi kesimpulan kuat.`
          : `Muncul di ${c.repeat} aturan ULANGI dan tidak pernah di aturan HINDARI. Ini tanda posisi UNTUNG.`,
      withRepeat: partners("ULANGI"),
      withAvoid: [],
    };
  }
  if (c.repeat === 0) {
    return {
      tone: "loss",
      text:
        c.avoid === 1
          ? `Baru sekali muncul, di aturan HINDARI. Belum cukup bukti untuk jadi kesimpulan kuat.`
          : `Muncul di ${c.avoid} aturan HINDARI dan tidak pernah di aturan ULANGI. Ini tanda posisi RUGI.`,
      withRepeat: [],
      withAvoid: partners("HINDARI"),
    };
  }
  return {
    tone: "mixed",
    text: `Muncul di ${c.repeat} aturan ULANGI dan ${c.avoid} aturan HINDARI. Sendirian ini bukan penentu: yang membedakan untung dan rugi adalah tanda lain yang muncul bersamanya.`,
    withRepeat: partners("ULANGI"),
    withAvoid: partners("HINDARI"),
  };
}

export interface Partner {
  key: string;
  label: string;
  count: number;
}

/** Concepts that shared a rule with `c` on the given side, most frequent first. */
export function partnerCounts(c: ConceptNode, web: LessonWeb, side: Side): Partner[] {
  const count = new Map<string, number>();
  for (const l of web.lessons)
    if (l.side === side && l.concepts.includes(c.key))
      for (const k of l.concepts) if (k !== c.key) count.set(k, (count.get(k) ?? 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => ({ key, label: web.concepts.find((x) => x.key === key)?.label ?? key, count: n }));
}

export type Strength = "kuat" | "sedang" | "lemah";
export type Group = "loss" | "mixed" | "profit" | "weak";

/** How much a one-sided concept can be trusted: 1 rule = weak, 2 = medium, 3+ = strong. */
export const strength = (c: Pick<ConceptNode, "total">): Strength => (c.total >= 3 ? "kuat" : c.total === 2 ? "sedang" : "lemah");

/** Which band of the spectrum a concept belongs to. Single sightings are held apart as weak evidence. */
export const groupOf = (c: Pick<ConceptNode, "repeat" | "avoid" | "total">): Group =>
  c.total < 2 ? "weak" : c.repeat === 0 ? "loss" : c.avoid === 0 ? "profit" : "mixed";

export interface Evidence {
  /** Mean pnl of the closed positions the concept's rules were learned from, per side. */
  avgPnl: Record<Side, number | null>;
  /** Screener track record summed over the concept's rules. */
  applied: number;
  wins: number;
  losses: number;
}

export function evidenceFor(c: ConceptNode, web: LessonWeb): Evidence {
  const pnls: Record<Side, number[]> = { ULANGI: [], HINDARI: [] };
  let applied = 0;
  let wins = 0;
  let losses = 0;
  for (const l of web.lessons) {
    if (!l.concepts.includes(c.key)) continue;
    if (l.pnl != null) pnls[l.side].push(l.pnl);
    applied += l.stats?.applied ?? 0;
    wins += l.stats?.wins ?? 0;
    losses += l.stats?.losses ?? 0;
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return { avgPnl: { ULANGI: avg(pnls.ULANGI), HINDARI: avg(pnls.HINDARI) }, applied, wins, losses };
}

// ── Layout ──

export interface Placed {
  key: string;
  x: number;
  y: number;
  r: number;
  /** Label baseline position after collision relaxation. */
  lx: number;
  ly: number;
  anchor: "start" | "middle" | "end";
  /** True when the label was pushed away from its node (draw a leader line). */
  moved: boolean;
}

export interface WebLayout {
  width: number;
  height: number;
  hubs: Record<Side, { x: number; y: number }>;
  nodes: Map<string, Placed>;
}

/** Rough label width in viewBox units at the 15px label font (+ the "N×" suffix). */
export const labelWidth = (c: Pick<ConceptNode, "label" | "total">) => c.label.length * 8.2 + 10 + String(c.total).length * 7 + 8;
export const LABEL_HEIGHT = 19;

export function labelBox(p: Placed, w: number) {
  const x0 = p.anchor === "start" ? p.lx : p.anchor === "end" ? p.lx - w : p.lx - w / 2;
  return { x0, x1: x0 + w, y0: p.ly - LABEL_HEIGHT + 4, y1: p.ly + 4 };
}

/**
 * Concepts sit on an ellipse ordered by lean: HINDARI-only on the left, ULANGI-only on the
 * right, mixed ones at the top and bottom between the two hubs. Labels point outward and are
 * then nudged vertically until no two overlap.
 */
export function layoutWeb(concepts: readonly ConceptNode[], width = 1000, height = 640): WebLayout {
  const cx = width / 2;
  const cy = height / 2;
  const rx = width * 0.29;
  const ry = height * 0.38;
  const ordered = [...concepts].sort((a, b) => lean(a) - lean(b) || b.total - a.total || a.key.localeCompare(b.key));
  const top = ordered.filter((_, i) => i % 2 === 0);
  const bottom = ordered.filter((_, i) => i % 2 === 1);
  const nodes = new Map<string, Placed>();
  const natural = new Map<string, number>();
  const place = (arc: ConceptNode[], sign: -1 | 1) => {
    arc.forEach((c, i) => {
      // From the left (π) over the top/bottom to the right (0), never exactly on the axis.
      const t = (i + 0.5) / arc.length;
      const angle = Math.PI * (1 - t);
      const ux = Math.cos(angle);
      const uy = -Math.sin(angle) * sign;
      const x = cx + rx * ux;
      const y = cy + ry * uy;
      const r = 7 + 5 * Math.sqrt(c.total);
      const side = Math.abs(ux) <= 0.25;
      const anchor = side ? "middle" : ux > 0 ? "start" : "end";
      const lx = side ? x : x + Math.sign(ux) * (r + 7);
      const ly = side ? (uy < 0 ? y - r - 7 : y + r + 18) : y + 5;
      natural.set(c.key, ly);
      nodes.set(c.key, { key: c.key, x, y, r, lx, ly, anchor, moved: false });
    });
  };
  place(top, 1);
  place(bottom, -1);

  // Push overlapping labels apart vertically.
  const list = [...nodes.values()];
  const width_ = new Map(concepts.map((c) => [c.key, labelWidth(c)]));
  for (let iter = 0; iter < 300; iter++) {
    let moved = false;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const A = labelBox(a, width_.get(a.key)!);
        const B = labelBox(b, width_.get(b.key)!);
        if (A.x1 <= B.x0 || B.x1 <= A.x0) continue;
        const gap = LABEL_HEIGHT + 1 - Math.abs(a.ly - b.ly);
        if (gap <= 0) continue;
        const dir = a.ly === b.ly ? (a.y <= b.y ? -1 : 1) : Math.sign(a.ly - b.ly);
        a.ly += (dir * gap) / 2;
        b.ly -= (dir * gap) / 2;
        moved = true;
      }
    for (const p of list) p.ly = Math.min(height - 4, Math.max(LABEL_HEIGHT, p.ly));
    if (!moved) break;
  }
  for (const p of list) p.moved = Math.abs(p.ly - natural.get(p.key)!) > 8;

  return {
    width,
    height,
    hubs: { HINDARI: { x: cx - rx * 0.42, y: cy }, ULANGI: { x: cx + rx * 0.42, y: cy } },
    nodes,
  };
}
