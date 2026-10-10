"use client";

import { useMemo, useState } from "react";
import { CHART } from "@/lib/chart";
import { labelBox, labelWidth, layoutWeb, type LessonWeb as Web, type Side } from "@/lib/lesson-web";

// SVG "jaring kesimpulan". Two hubs (HINDARI left, ULANGI right); every concept node is a pie of
// how often it appeared in each kind of rule; grey threads join concepts used in the same rule.

export type Selection = { kind: "concept"; key: string } | { kind: "hub"; side: Side } | null;

const W = 1000;
const H = 640;
const SIDE_COLOR: Record<Side, string> = { ULANGI: CHART.profit, HINDARI: CHART.loss };

function pieSlice(cx: number, cy: number, r: number, from: number, to: number) {
  const a0 = from * 2 * Math.PI - Math.PI / 2;
  const a1 = to * 2 * Math.PI - Math.PI / 2;
  const large = to - from > 0.5 ? 1 : 0;
  return `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`;
}

export function LessonWeb({
  web,
  selected,
  onSelect,
}: {
  web: Web;
  selected: Selection;
  onSelect: (s: Selection) => void;
}) {
  const [hover, setHover] = useState<Selection>(null);
  const lay = useMemo(() => layoutWeb(web.concepts, W, H), [web.concepts]);
  const active = hover ?? selected;

  // Widen the viewBox to whatever the outermost labels need, so long labels never clip.
  const view = useMemo(() => {
    let x0 = 0;
    let x1 = W;
    let y0 = 0;
    let y1 = H;
    for (const c of web.concepts) {
      const b = labelBox(lay.nodes.get(c.key)!, labelWidth(c));
      x0 = Math.min(x0, b.x0 - 8);
      x1 = Math.max(x1, b.x1 + 8);
      y0 = Math.min(y0, b.y0 - 4);
      y1 = Math.max(y1, b.y1 + 4);
    }
    return `${x0} ${y0} ${x1 - x0} ${y1 - y0}`;
  }, [web.concepts, lay]);

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of web.edges) {
      if (!m.has(e.a)) m.set(e.a, new Set());
      if (!m.has(e.b)) m.set(e.b, new Set());
      m.get(e.a)!.add(e.b);
      m.get(e.b)!.add(e.a);
    }
    return m;
  }, [web.edges]);

  const byKey = useMemo(() => new Map(web.concepts.map((c) => [c.key, c])), [web.concepts]);

  const lit = (key: string) => {
    if (!active) return true;
    if (active.kind === "concept") return key === active.key || !!neighbors.get(active.key)?.has(key);
    const c = byKey.get(key)!;
    return active.side === "ULANGI" ? c.repeat > 0 : c.avoid > 0;
  };
  const edgeLit = (a: string, b: string) => {
    if (!active) return false;
    if (active.kind === "concept") return a === active.key || b === active.key;
    return false;
  };

  const sameSel = (s: Selection) =>
    JSON.stringify(s) === JSON.stringify(selected) ? null : s;

  const cx = W / 2;
  const cy = H / 2;
  const curve = (x1: number, y1: number, x2: number, y2: number, pull: number) => {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    return `M${x1},${y1} Q${mx + (cx - mx) * pull},${my + (cy - my) * pull} ${x2},${y2}`;
  };

  return (
    <svg
      viewBox={view}
      className="h-auto w-full select-none"
      role="img"
      aria-label="Jaring kesimpulan: tanda-tanda yang dipelajari AI dan hubungannya"
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
    >
      <defs>
        {(["ULANGI", "HINDARI"] as const).map((side) => (
          <radialGradient key={side} id={`hub-${side}`} cx="50%" cy="40%" r="65%">
            <stop offset="0%" stopColor={SIDE_COLOR[side]} stopOpacity={0.32} />
            <stop offset="100%" stopColor={SIDE_COLOR[side]} stopOpacity={0.08} />
          </radialGradient>
        ))}
      </defs>

      {/* threads between concepts in the same rule */}
      {web.edges.map((e) => {
        const a = lay.nodes.get(e.a)!;
        const b = lay.nodes.get(e.b)!;
        const on = edgeLit(e.a, e.b);
        return (
          <path
            key={`${e.a}|${e.b}`}
            d={curve(a.x, a.y, b.x, b.y, 0.35)}
            fill="none"
            stroke={on ? CHART.accent : CHART.axis}
            strokeOpacity={on ? 0.9 : active ? 0.06 : 0.16 + 0.08 * e.count}
            strokeWidth={0.8 + e.count * 0.9}
            style={{ transition: "stroke-opacity 200ms, stroke 200ms" }}
          />
        );
      })}

      {/* concept → hub spokes */}
      {web.concepts.map((c) => {
        const n = lay.nodes.get(c.key)!;
        const on = active ? lit(c.key) && (active.kind === "hub" || active.key === c.key) : true;
        return (["ULANGI", "HINDARI"] as const).map((side) => {
          const count = side === "ULANGI" ? c.repeat : c.avoid;
          if (!count) return null;
          if (active?.kind === "hub" && active.side !== side) return null;
          const h = lay.hubs[side];
          return (
            <path
              key={`${c.key}-${side}`}
              d={curve(n.x, n.y, h.x, h.y, 0.15)}
              fill="none"
              stroke={SIDE_COLOR[side]}
              strokeOpacity={on ? (active ? 0.75 : 0.22) : 0.04}
              strokeWidth={1 + count * 1.4}
              strokeLinecap="round"
              style={{ transition: "stroke-opacity 200ms" }}
            />
          );
        });
      })}

      {/* hubs */}
      {(["HINDARI", "ULANGI"] as const).map((side) => {
        const h = lay.hubs[side];
        const count = web.lessons.filter((l) => l.side === side).length;
        const isSel = selected?.kind === "hub" && selected.side === side;
        const dim = active && !(active.kind === "hub" && active.side === side) && active.kind !== "concept";
        return (
          <g
            key={side}
            role="button"
            tabIndex={0}
            aria-label={`Aturan ${side}`}
            className="cursor-pointer outline-none"
            opacity={dim ? 0.35 : 1}
            style={{ transition: "opacity 200ms" }}
            onMouseEnter={() => setHover({ kind: "hub", side })}
            onMouseLeave={() => setHover(null)}
            onClick={() => onSelect(sameSel({ kind: "hub", side }))}
            onKeyDown={(e) => e.key === "Enter" && onSelect(sameSel({ kind: "hub", side }))}
          >
            <circle cx={h.x} cy={h.y} r={62} fill="none" stroke={SIDE_COLOR[side]} strokeOpacity={isSel ? 0.35 : 0.12} strokeWidth={1} strokeDasharray="2 5" />
            <circle cx={h.x} cy={h.y} r={50} fill="var(--surface-1)" />
            <circle cx={h.x} cy={h.y} r={50} fill={`url(#hub-${side})`} stroke={SIDE_COLOR[side]} strokeWidth={isSel ? 3.5 : 1.5} />
            <text x={h.x} y={h.y - 4} textAnchor="middle" fontSize={17} fontWeight={700} fill={SIDE_COLOR[side]}>
              {side}
            </text>
            <text x={h.x} y={h.y + 16} textAnchor="middle" fontSize={12} fill="var(--text-secondary)">
              {count} aturan
            </text>
          </g>
        );
      })}

      {/* concept nodes */}
      {web.concepts.map((c) => {
        const n = lay.nodes.get(c.key)!;
        const on = lit(c.key);
        const isSel = selected?.kind === "concept" && selected.key === c.key;
        const share = c.repeat / c.total;
        return (
          <g
            key={c.key}
            role="button"
            tabIndex={0}
            aria-label={`${c.label}: ${c.repeat} ulangi, ${c.avoid} hindari`}
            className="cursor-pointer outline-none"
            opacity={on ? 1 : 0.15}
            style={{ transition: "opacity 200ms" }}
            onMouseEnter={() => setHover({ kind: "concept", key: c.key })}
            onMouseLeave={() => setHover(null)}
            onClick={() => onSelect(sameSel({ kind: "concept", key: c.key }))}
            onKeyDown={(e) => e.key === "Enter" && onSelect(sameSel({ kind: "concept", key: c.key }))}
          >
            {isSel ? <circle cx={n.x} cy={n.y} r={n.r + 11} fill={CHART.accent} fillOpacity={0.14} /> : null}
            {share === 0 || share === 1 ? (
              <circle cx={n.x} cy={n.y} r={n.r} fill={share === 1 ? CHART.profit : CHART.loss} />
            ) : (
              <>
                <path d={pieSlice(n.x, n.y, n.r, 0, share)} fill={CHART.profit} />
                <path d={pieSlice(n.x, n.y, n.r, share, 1)} fill={CHART.loss} />
              </>
            )}
            <circle cx={n.x} cy={n.y} r={n.r + (isSel ? 4 : 0)} fill="none" stroke={isSel ? CHART.accent : "var(--surface-1)"} strokeWidth={isSel ? 3 : 1.5} />
            {n.moved ? (
              <line
                x1={n.x + (n.anchor === "start" ? n.r : n.anchor === "end" ? -n.r : 0)}
                y1={n.y}
                x2={n.lx}
                y2={n.ly - 5}
                stroke={CHART.axis}
                strokeOpacity={0.5}
                strokeWidth={1}
              />
            ) : null}
            <text
              x={n.lx}
              y={n.ly}
              textAnchor={n.anchor}
              fontSize={15}
              fontWeight={isSel ? 700 : 500}
              fill="var(--text-primary)"
              stroke="var(--surface-1)"
              strokeWidth={4}
              paintOrder="stroke"
            >
              {c.label}
              <tspan fill="var(--text-tertiary)" fontWeight={400} fontSize={12}>
                {"  "}
                {c.total}×
              </tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}
