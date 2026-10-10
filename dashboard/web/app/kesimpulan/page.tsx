"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Graph,
  Prohibit,
  CheckCircle,
  ArrowsLeftRight,
  X,
  CaretDown,
  ArrowRight,
  Lightbulb,
  ChartLineUp,
  Robot,
  Clock,
  Sparkle,
} from "@phosphor-icons/react";
import { useFile } from "@/lib/hooks";
import { SkeletonRows, Skeleton, EmptyState, ErrorState } from "@/components/states";
import { LessonWeb, type Selection } from "@/components/LessonWeb";
import {
  buildLessonWeb,
  conclude,
  evidenceFor,
  groupOf,
  lean,
  partnerCounts,
  strength,
  type ConceptNode,
  type Group,
  type LessonWeb as Web,
  type Partner,
  type Side,
  type WebLesson,
  type WebLessonInput,
} from "@/lib/lesson-web";
import { relativeTime } from "@/lib/format";
import { CHART } from "@/lib/chart";
import { cn } from "@/lib/cn";

// "Kesimpulan": what the AI concluded from closed positions, read sign by sign. The spectrum
// (HINDARI ← → ULANGI) is the primary read; the web below shows which signs travel together.

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

const TONE = {
  profit: { color: CHART.profit, tint: "var(--profit-tint)" },
  loss: { color: CHART.loss, tint: "var(--loss-tint)" },
  mixed: { color: "var(--warning)", tint: "var(--warning-tint)" },
} as const;

const GROUPS: Record<Group, { title: string; hint: string; color: string }> = {
  loss: { title: "Tanda rugi", hint: "Hanya muncul di aturan HINDARI.", color: CHART.loss },
  mixed: { title: "Tergantung tanda lain", hint: "Muncul di dua sisi. Yang menentukan adalah tanda yang menyertainya.", color: "var(--warning)" },
  profit: { title: "Tanda untung", hint: "Hanya muncul di aturan ULANGI.", color: CHART.profit },
  weak: { title: "Baru sekali muncul", hint: "Belum cukup bukti untuk ditarik kesimpulan.", color: "var(--text-tertiary)" },
};

const STRENGTH_LABEL = { kuat: "Bukti kuat", sedang: "Bukti sedang", lemah: "Bukti lemah" } as const;

// ── Small pieces ──

function SplitBar({ repeat, avoid, className }: { repeat: number; avoid: number; className?: string }) {
  const total = repeat + avoid;
  const share = total ? (avoid / total) * 100 : 0;
  return (
    <div className={cn("flex h-2 w-full overflow-hidden rounded-full bg-surface-2", className)} aria-hidden>
      {avoid ? <div className="mrd-grow h-full" style={{ width: `${share}%`, background: CHART.loss, transformOrigin: "left" }} /> : null}
      {repeat ? (
        <div className="mrd-grow h-full" style={{ width: `${100 - share}%`, background: CHART.profit, transformOrigin: "right", marginLeft: avoid ? 2 : 0 }} />
      ) : null}
    </div>
  );
}

function SideFlag({ side }: { side: Side }) {
  const win = side === "ULANGI";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[3px] px-1.5 py-px text-[10px] font-semibold tracking-[0.06em]"
      style={{ color: win ? CHART.profit : CHART.loss, background: win ? "var(--profit-tint)" : "var(--loss-tint)" }}
    >
      {win ? <CheckCircle size={11} weight="fill" /> : <Prohibit size={11} weight="bold" />}
      {side}
    </span>
  );
}

function SectionHead({ icon, title, hint, right }: { icon: React.ReactNode; title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-md)] bg-surface-2 text-text-secondary">{icon}</span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-text-primary">{title}</h2>
          {hint ? <p className="max-w-[68ch] text-[12.5px] leading-relaxed text-text-tertiary [text-wrap:pretty]">{hint}</p> : null}
        </div>
      </div>
      {right}
    </div>
  );
}

function PartnerChips({ list, tone, onPick, activeKey }: { list: Partner[]; tone: "profit" | "loss"; onPick: (k: string) => void; activeKey?: string }) {
  if (!list.length) return <p className="text-[12px] text-text-tertiary">Tidak ada. Tanda ini selalu berdiri sendiri.</p>;
  const t = TONE[tone];
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.slice(0, 8).map((p) => (
        <button
          key={p.key}
          onClick={() => onPick(p.key)}
          className={cn(
            "group inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border px-2 py-1 text-[12px] transition-colors duration-200",
            p.key === activeKey ? "border-accent-bright" : "border-transparent hover:border-border-strong"
          )}
          style={{ background: t.tint }}
        >
          <span className="text-text-primary">{p.label}</span>
          <span className="font-mono text-[11px] tnum" style={{ color: t.color }}>
            {p.count}×
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Spectrum (primary view) ──

function SpectrumRow({
  c,
  max,
  selected,
  onPick,
  delay,
}: {
  c: ConceptNode;
  max: number;
  selected: boolean;
  onPick: () => void;
  delay: number;
}) {
  const weak = c.total < 2;
  const bar = (n: number, side: Side) => {
    if (!n) return null;
    const win = side === "ULANGI";
    const color = win ? CHART.profit : CHART.loss;
    return (
      <span
        className="mrd-grow block h-2.5 rounded-[3px]"
        style={{
          width: `${Math.max(6, (n / max) * 100)}%`,
          transformOrigin: win ? "left" : "right",
          animationDelay: `${delay}ms`,
          background: `linear-gradient(${win ? "90deg" : "270deg"}, color-mix(in srgb, ${color} 45%, transparent), ${color})`,
        }}
      />
    );
  };
  return (
    <li>
      <button
        onClick={onPick}
        aria-pressed={selected}
        aria-label={`${c.label}: ${c.avoid} aturan HINDARI, ${c.repeat} aturan ULANGI`}
        className={cn(
          "group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] px-2.5 py-2 text-left transition-colors duration-200",
          "sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_2.25rem] xl:grid-cols-[minmax(0,13.5rem)_minmax(0,1fr)_2.25rem]",
          selected ? "bg-accent-tint" : "hover:bg-surface-2 active:bg-surface-3",
          weak && !selected && "opacity-70 hover:opacity-100"
        )}
      >
        <span className="order-1 flex min-w-0 items-center gap-2">
          <span
            className={cn("h-4 w-[3px] shrink-0 rounded-full transition-opacity", selected ? "opacity-100" : "opacity-0")}
            style={{ background: CHART.accent }}
          />
          <span className={cn("line-clamp-2 text-[13px] leading-snug text-text-primary", selected && "font-semibold")}>{c.label}</span>
        </span>
        <span className="order-2 text-right font-mono text-[11px] tnum text-text-tertiary sm:order-3">{c.total}×</span>
        <span className="order-3 col-span-2 grid grid-cols-2 items-center sm:order-2 sm:col-span-1">
          <span className="flex items-center justify-end gap-1.5 border-r border-border-strong pr-1">
            {c.avoid ? <span className="font-mono text-[11px] tnum text-loss">{c.avoid}</span> : null}
            {bar(c.avoid, "HINDARI")}
          </span>
          <span className="flex items-center gap-1.5 pl-1">
            {bar(c.repeat, "ULANGI")}
            {c.repeat ? <span className="font-mono text-[11px] tnum text-profit">{c.repeat}</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

function Spectrum({ web, selectedKey, onPick }: { web: Web; selectedKey: string | null; onPick: (k: string) => void }) {
  const [showWeak, setShowWeak] = useState(false);
  const max = Math.max(1, ...web.concepts.map((c) => Math.max(c.repeat, c.avoid)));
  const groups = useMemo(() => {
    const by: Record<Group, ConceptNode[]> = { loss: [], mixed: [], profit: [], weak: [] };
    for (const c of web.concepts) by[groupOf(c)].push(c);
    by.loss.sort((a, b) => b.avoid - a.avoid || b.total - a.total);
    by.profit.sort((a, b) => b.repeat - a.repeat || b.total - a.total);
    by.mixed.sort((a, b) => lean(a) - lean(b) || b.total - a.total);
    by.weak.sort((a, b) => lean(a) - lean(b));
    return by;
  }, [web.concepts]);

  // A weak concept picked from the web stays visible.
  const weakOpen = showWeak || groups.weak.some((c) => c.key === selectedKey);
  let i = 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="sticky top-14 z-[1] hidden grid-cols-[minmax(0,11rem)_minmax(0,1fr)_2.25rem] xl:grid-cols-[minmax(0,13.5rem)_minmax(0,1fr)_2.25rem] gap-x-3 border-b border-border bg-surface-1/95 px-2.5 pb-2 pt-1 backdrop-blur sm:grid">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary">Tanda</span>
        <span className="grid grid-cols-2 whitespace-nowrap text-[11px] font-semibold tracking-[0.06em]">
          <span className="pr-2 text-right text-loss">← HINDARI</span>
          <span className="pl-2 text-profit">ULANGI →</span>
        </span>
        <span className="text-right text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary">Σ</span>
      </div>

      <div className="sticky top-14 z-[1] grid grid-cols-2 border-b border-border bg-surface-1/95 px-2.5 pb-2 pt-1 text-[11px] font-semibold tracking-[0.06em] backdrop-blur sm:hidden">
        <span className="pr-2 text-right text-loss">← HINDARI</span>
        <span className="pl-2 text-profit">ULANGI →</span>
      </div>

      {(["loss", "mixed", "profit", "weak"] as const).map((g) => {
        const list = groups[g];
        if (!list.length) return null;
        const meta = GROUPS[g];
        const collapsible = g === "weak";
        const open = !collapsible || weakOpen;
        return (
          <section key={g} className="mt-3 first-of-type:mt-1">
            <div className="flex items-baseline gap-2 px-2.5 pb-1">
              <span className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full" style={{ background: meta.color }} />
              <h3 className="whitespace-nowrap text-[12.5px] font-semibold text-text-primary">{meta.title}</h3>
              <span className="font-mono text-[11px] tnum text-text-tertiary">{list.length}</span>
              <span className="hidden min-w-0 truncate text-[12px] text-text-tertiary md:inline">· {meta.hint}</span>
              {collapsible ? (
                <button
                  onClick={() => setShowWeak((v) => !v)}
                  className="ml-auto inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                  aria-expanded={open}
                >
                  {open ? "Sembunyikan" : "Tampilkan"}
                  <CaretDown size={12} className={cn("transition-transform duration-200", open && "rotate-180")} />
                </button>
              ) : null}
            </div>
            {open ? (
              <ul className="flex flex-col">
                {list.map((c) => (
                  <SpectrumRow key={c.key} c={c} max={max} selected={c.key === selectedKey} onPick={() => onPick(c.key)} delay={Math.min(i++ * 35, 600)} />
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

// ── Detail panel ──

function LessonItem({ l, activeKey, onPick }: { l: WebLesson; activeKey?: string; onPick?: (k: string) => void }) {
  const win = l.side === "ULANGI";
  return (
    <li className="mrd-rise relative overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-2/60 p-3 pl-3.5">
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: win ? CHART.profit : CHART.loss }} aria-hidden />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-tertiary">
        <SideFlag side={l.side} />
        {l.source === "follow" ? (
          <span>dari wallet yang diikuti</span>
        ) : (
          <>
            <span className="font-mono text-[11.5px] text-text-secondary">{l.pool ?? "posisi"}</span>
            {l.pnl != null ? (
              <span className={cn("font-mono tnum font-medium", l.pnl > 0 ? "text-profit" : "text-loss")}>{pct(l.pnl)}</span>
            ) : null}
          </>
        )}
        {l.created_at ? <span className="ml-auto">{relativeTime(l.created_at)}</span> : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {l.plain.conditions.map((c, i) => {
          const on = c.concept.key === activeKey;
          return (
            <button
              key={i}
              title={c.raw}
              onClick={() => onPick?.(c.concept.key)}
              disabled={!onPick || on}
              className={cn(
                "rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[12px] transition-colors duration-200",
                on ? "border-accent-bright bg-accent-tint font-medium text-text-primary" : "border-border bg-surface-1 text-text-secondary enabled:hover:border-border-strong enabled:hover:text-text-primary"
              )}
            >
              {c.gist}
            </button>
          );
        })}
      </div>
      {l.plain.explanation ? (
        <p className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-text-tertiary [text-wrap:pretty]" title={l.plain.explanation}>
          {l.plain.explanation}
        </p>
      ) : null}
      {l.stats && l.stats.applied > 0 ? (
        <div className="mt-2 flex items-center gap-2 border-t border-border pt-2 text-[11.5px] text-text-tertiary">
          <Robot size={13} />
          <span>Dipakai screener {l.stats.applied}×</span>
          <span className="ml-auto font-mono tnum">
            <span className="text-profit">{l.stats.wins}U</span> · <span className="text-loss">{l.stats.losses}R</span>
          </span>
        </div>
      ) : null}
    </li>
  );
}

function PanelHeader({ eyebrow, eyebrowColor, title, onClose }: { eyebrow: string; eyebrowColor: string; title: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: eyebrowColor }}>
          {eyebrow}
        </div>
        <h2 className="mt-1 text-[20px] font-semibold leading-tight tracking-[-0.015em] text-text-primary [text-wrap:balance]">{title}</h2>
      </div>
      <button
        onClick={onClose}
        aria-label="Tutup (Esc)"
        title="Tutup (Esc)"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-md)] text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <X size={16} />
      </button>
    </div>
  );
}

function Fact({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-surface-2/70 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
        {icon}
        {label}
      </div>
      <div className="text-[13px] text-text-primary">{children}</div>
    </div>
  );
}

function ConceptPanel({ c, web, onPick, onClose }: { c: ConceptNode; web: Web; onPick: (k: string) => void; onClose: () => void }) {
  const k = conclude(c, web);
  const tone = TONE[k.tone];
  const ev = evidenceFor(c, web);
  const st = strength(c);
  const stLabel = k.tone === "mixed" ? "Bertentangan" : STRENGTH_LABEL[st];
  const stMuted = k.tone !== "mixed" && st === "lemah";
  const withRepeat = partnerCounts(c, web, "ULANGI");
  const withAvoid = partnerCounts(c, web, "HINDARI");
  const lessons = c.lessons
    .map((id) => web.lessons.find((l) => l.id === id))
    .filter((l): l is WebLesson => !!l)
    .reverse();
  const eyebrow = k.tone === "profit" ? "Tanda untung" : k.tone === "loss" ? "Tanda rugi" : "Tergantung tanda lain";
  const Icon = k.tone === "profit" ? CheckCircle : k.tone === "loss" ? Prohibit : ArrowsLeftRight;

  return (
    <div key={c.key} className="mrd-rise flex flex-col gap-4">
      <PanelHeader eyebrow={eyebrow} eyebrowColor={tone.color} title={c.label} onClose={onClose} />

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-[12px]">
          <span className="font-mono tnum text-loss">{c.avoid} HINDARI</span>
          <span
            className="rounded-[3px] px-1.5 py-px text-[10.5px] font-medium"
            style={{ color: stMuted ? "var(--text-tertiary)" : tone.color, background: stMuted ? "var(--surface-2)" : tone.tint }}
          >
            {stLabel} · {c.total} aturan
          </span>
          <span className="font-mono tnum text-profit">{c.repeat} ULANGI</span>
        </div>
        <SplitBar key={c.key} repeat={c.repeat} avoid={c.avoid} />
      </div>

      <div className="flex gap-2.5 rounded-[var(--radius-lg)] p-3" style={{ background: tone.tint }}>
        <Icon size={18} weight="fill" className="mt-0.5 shrink-0" style={{ color: tone.color }} />
        <p className="text-[13px] leading-relaxed text-text-primary [text-wrap:pretty]">{k.text}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Fact icon={<ChartLineUp size={13} />} label="Hasil posisi asal">
          {ev.avgPnl.HINDARI == null && ev.avgPnl.ULANGI == null ? (
            <span className="text-text-tertiary">—</span>
          ) : (
            <span className="flex flex-col font-mono text-[12.5px] tnum">
              {ev.avgPnl.ULANGI != null ? <span className="text-profit">ULANGI {pct(ev.avgPnl.ULANGI)}</span> : null}
              {ev.avgPnl.HINDARI != null ? <span className="text-loss">HINDARI {pct(ev.avgPnl.HINDARI)}</span> : null}
            </span>
          )}
        </Fact>
        <Fact icon={<Robot size={13} />} label="Dipakai screener">
          {ev.applied ? (
            <span className="font-mono text-[12.5px] tnum">
              {ev.applied}× · <span className="text-profit">{ev.wins}U</span> <span className="text-loss">{ev.losses}R</span>
            </span>
          ) : (
            <span className="text-text-tertiary">Belum pernah</span>
          )}
        </Fact>
        {c.tfs.length ? (
          <Fact icon={<Clock size={13} />} label="Dilihat di chart">
            {c.tfs.join(" & ")}
          </Fact>
        ) : null}
      </div>

      {k.tone === "mixed" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="text-[12px] font-medium text-text-secondary">
              Jadi <span className="text-profit">ULANGI</span> kalau muncul bersama
            </div>
            <PartnerChips list={withRepeat} tone="profit" onPick={onPick} />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="text-[12px] font-medium text-text-secondary">
              Jadi <span className="text-loss">HINDARI</span> kalau muncul bersama
            </div>
            <PartnerChips list={withAvoid} tone="loss" onPick={onPick} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="text-[12px] font-medium text-text-secondary">Biasanya muncul bersama</div>
          <PartnerChips list={k.tone === "profit" ? withRepeat : withAvoid} tone={k.tone} onPick={onPick} />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <div className="text-[12px] font-medium text-text-secondary">Aturan asal</div>
          <div className="text-[11px] text-text-tertiary">terbaru di atas</div>
        </div>
        <ul className="flex flex-col gap-2">
          {lessons.map((l) => (
            <LessonItem key={l.id} l={l} activeKey={c.key} onPick={onPick} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function HubPanel({ side, web, onPick, onClose }: { side: Side; web: Web; onPick: (k: string) => void; onClose: () => void }) {
  const list = web.lessons.filter((l) => l.side === side).reverse();
  const win = side === "ULANGI";
  return (
    <div key={side} className="mrd-rise flex flex-col gap-4">
      <PanelHeader
        eyebrow={win ? "Dipelajari dari posisi untung" : "Dipelajari dari posisi rugi"}
        eyebrowColor={win ? CHART.profit : CHART.loss}
        title={`Semua aturan ${side}`}
        onClose={onClose}
      />
      <p className="text-[12.5px] text-text-tertiary">{list.length} aturan, terbaru di atas. Klik satu tanda untuk melihat kesimpulannya.</p>
      <ul className="flex flex-col gap-2">
        {list.map((l) => (
          <LessonItem key={l.id} l={l} onPick={onPick} />
        ))}
      </ul>
    </div>
  );
}

function Overview({ web, onPick }: { web: Web; onPick: (k: string) => void }) {
  const loss = web.concepts.filter((c) => groupOf(c) === "loss").sort((a, b) => b.avoid - a.avoid)[0];
  const win = web.concepts.filter((c) => groupOf(c) === "profit").sort((a, b) => b.repeat - a.repeat)[0];
  const mixed = web.concepts.filter((c) => groupOf(c) === "mixed").sort((a, b) => b.total - a.total)[0];
  const insights = [
    loss && {
      c: loss,
      tone: TONE.loss,
      icon: <Prohibit size={16} weight="bold" />,
      tag: "Paling jelas merugikan",
      text: (
        <>
          Setiap aturan yang menyebut <b className="font-semibold">{loss.label}</b> berkata HINDARI, {loss.avoid} dari {loss.avoid}.
        </>
      ),
    },
    win && {
      c: win,
      tone: TONE.profit,
      icon: <CheckCircle size={16} weight="fill" />,
      tag: "Paling jelas menguntungkan",
      text: (
        <>
          <b className="font-semibold">{win.label}</b> hanya muncul di aturan ULANGI, {win.repeat} kali, tanpa satu pun HINDARI.
        </>
      ),
    },
    mixed && {
      c: mixed,
      tone: TONE.mixed,
      icon: <ArrowsLeftRight size={16} weight="bold" />,
      tag: "Paling sering diperdebatkan",
      text: (
        <>
          <b className="font-semibold">{mixed.label}</b> muncul {mixed.repeat}× di ULANGI dan {mixed.avoid}× di HINDARI. Sendirian, tanda ini tidak
          menentukan apa-apa.
        </>
      ),
    },
  ].filter(Boolean) as { c: ConceptNode; tone: (typeof TONE)[keyof typeof TONE]; icon: React.ReactNode; tag: string; text: React.ReactNode }[];

  return (
    <div className="mrd-rise flex flex-col gap-4">
      <div>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-bright">
          <Sparkle size={12} weight="fill" /> Ringkasan
        </div>
        <h2 className="mt-1 text-[20px] font-semibold leading-tight tracking-[-0.015em] text-text-primary">Yang paling jelas sejauh ini</h2>
      </div>
      <ul className="flex flex-col gap-2">
        {insights.map((it) => (
          <li key={it.c.key}>
            <button
              onClick={() => onPick(it.c.key)}
              className="group relative flex w-full flex-col gap-1.5 overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-2/50 p-3 pl-3.5 text-left transition-[border-color,background-color,transform] duration-200 hover:border-border-strong hover:bg-surface-2 active:translate-y-px"
            >
              <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: it.tone.color }} aria-hidden />
              <span className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: it.tone.color }}>
                {it.icon}
                {it.tag}
              </span>
              <span className="text-[13px] leading-relaxed text-text-secondary [text-wrap:pretty]">{it.text}</span>
              <span className="flex items-center gap-1 text-[12px] text-text-tertiary transition-colors group-hover:text-accent-bright">
                Lihat aturannya <ArrowRight size={12} className="transition-transform duration-200 group-hover:translate-x-0.5" />
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="rounded-[var(--radius-lg)] border border-dashed border-border-strong p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
          <Lightbulb size={14} /> Cara membaca
        </div>
        <ol className="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-text-tertiary">
          <li>
            <span className="text-loss">Batang merah ke kiri</span>: berapa aturan HINDARI yang memakai tanda itu.{" "}
            <span className="text-profit">Hijau ke kanan</span>: aturan ULANGI.
          </li>
          <li>Makin banyak aturan, makin kuat buktinya. Tanda yang baru sekali muncul dipisah di bawah.</li>
          <li>Klik tanda untuk melihat aturan asalnya dan tanda yang sering menyertainya.</li>
        </ol>
      </div>
    </div>
  );
}

// ── Page ──

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-[var(--radius-xl)] border border-border bg-surface-1 p-6">
        <Skeleton className="mb-3 h-3 w-28" />
        <Skeleton className="mb-2 h-7 w-56" />
        <Skeleton className="h-3 w-[min(520px,90%)]" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)]">
        <div className="rounded-[var(--radius-xl)] border border-border bg-surface-1 p-4">
          <SkeletonRows rows={9} />
        </div>
        <div className="rounded-[var(--radius-xl)] border border-border bg-surface-1 p-4">
          <SkeletonRows rows={5} />
        </div>
      </div>
    </div>
  );
}

export default function KesimpulanPage() {
  const q = useFile<{ lessons?: WebLessonInput[] }>("lessons");
  const [selected, setSelected] = useState<Selection>(null);
  const panelRef = useRef<HTMLElement>(null);

  // Below lg the panel sits under the spectrum — bring it into view when something is picked.
  useEffect(() => {
    if (selected && panelRef.current && window.matchMedia("(max-width: 1023px)").matches) {
      panelRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (selected && panelRef.current) panelRef.current.scrollTop = 0;
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const web = useMemo(() => buildLessonWeb(q.data?.lessons ?? []), [q.data]);
  const byKey = useMemo(() => new Map(web.concepts.map((c) => [c.key, c])), [web.concepts]);

  if (q.isLoading) return <PageSkeleton />;
  if (q.isError) return <ErrorState message="Gagal memuat lessons.json." onRetry={() => q.refetch()} />;

  const pick = (key: string) => setSelected({ kind: "concept", key });
  const close = () => setSelected(null);
  const repeatRules = web.lessons.filter((l) => l.side === "ULANGI").length;
  const avoidRules = web.lessons.length - repeatRules;
  const strong = web.concepts.filter((c) => c.total >= 2 && (c.repeat === 0 || c.avoid === 0)).length;
  const selectedKey = selected?.kind === "concept" ? selected.key : null;

  let panel: React.ReactNode;
  if (selected?.kind === "concept" && byKey.get(selected.key)) {
    panel = <ConceptPanel c={byKey.get(selected.key)!} web={web} onPick={pick} onClose={close} />;
  } else if (selected?.kind === "hub") {
    panel = <HubPanel side={selected.side} web={web} onPick={pick} onClose={close} />;
  } else {
    panel = <Overview web={web} onPick={pick} />;
  }

  return (
    <div className="flex flex-col gap-5">
      <header
        className="relative overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface-1 p-5 md:p-6"
        style={{
          backgroundImage:
            "radial-gradient(60% 120% at 0% 0%, var(--loss-tint), transparent 60%), radial-gradient(60% 120% at 100% 0%, var(--profit-tint), transparent 60%)",
        }}
      >
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
              <Graph size={13} weight="bold" /> Pembelajaran AI
            </div>
            <h1 className="mt-1.5 text-[26px] font-semibold leading-tight tracking-[-0.025em] text-text-primary md:text-[30px]">Kesimpulan</h1>
            <p className="mt-1.5 max-w-[62ch] text-[13px] leading-relaxed text-text-secondary [text-wrap:pretty]">
              Setiap posisi yang ditutup menghasilkan satu aturan: <span className="font-medium text-profit">ULANGI</span> atau{" "}
              <span className="font-medium text-loss">HINDARI</span>. Di sini aturan-aturan itu dipecah menjadi tanda di chart, supaya terlihat tanda mana
              yang benar-benar membedakan posisi untung dari posisi rugi.
            </p>
          </div>
          {web.lessons.length ? (
            <dl className="grid shrink-0 grid-cols-3 gap-px overflow-hidden rounded-[var(--radius-lg)] border border-border bg-border lg:w-[420px]">
              {[
                { label: "Aturan terukur", value: web.lessons.length },
                { label: "Tanda unik", value: web.concepts.length },
                { label: "Kesimpulan tegas", value: strong },
              ].map((s) => (
                <div key={s.label} className="bg-surface-1/90 px-3 py-2.5">
                  <dt className="text-[11px] text-text-tertiary">{s.label}</dt>
                  <dd className="mt-0.5 font-mono text-[20px] font-semibold tnum tracking-[-0.02em] text-text-primary">{s.value}</dd>
                </div>
              ))}
              <div className="col-span-3 flex flex-col gap-1.5 bg-surface-1/90 px-3 py-2.5">
                <div className="flex justify-between text-[11px]">
                  <span className="text-loss">
                    <span className="font-mono font-semibold tnum">{avoidRules}</span> HINDARI
                  </span>
                  <span className="text-profit">
                    ULANGI <span className="font-mono font-semibold tnum">{repeatRules}</span>
                  </span>
                </div>
                <SplitBar repeat={repeatRules} avoid={avoidRules} className="h-1.5" />
              </div>
            </dl>
          ) : null}
        </div>
      </header>

      {web.lessons.length === 0 ? (
        <div className="rounded-[var(--radius-xl)] border border-border bg-surface-1">
          <EmptyState icon={Graph} title="Belum ada aturan yang bisa dipetakan" hint="Halaman ini terisi setelah AI menulis aturan otomatis dari posisi yang ditutup." />
        </div>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)]">
          <div className="flex min-w-0 flex-col gap-5">
            <section className="rounded-[var(--radius-xl)] border border-border bg-surface-1 p-4 md:p-5">
              <SectionHead
                icon={<ArrowsLeftRight size={15} weight="bold" />}
                title="Spektrum tanda"
                hint="Tiap baris adalah satu tanda di chart. Panjang batang = jumlah aturan yang memakainya, di sisi HINDARI atau ULANGI."
              />
              <div className="mt-3">
                <Spectrum web={web} selectedKey={selectedKey} onPick={(k) => setSelected(selectedKey === k ? null : { kind: "concept", key: k })} />
              </div>
            </section>

            <section className="rounded-[var(--radius-xl)] border border-border bg-surface-1 p-4 md:p-5">
              <SectionHead
                icon={<Graph size={15} weight="bold" />}
                title="Jaring hubungan"
                hint="Tanda yang muncul bersama dalam satu aturan dihubungkan benang. Arahkan kursor ke tanda untuk melihat pasangannya, klik pusat ULANGI/HINDARI untuk semua aturannya."
              />
              <div className="mt-3 rounded-[var(--radius-lg)] bg-[radial-gradient(ellipse_at_center,var(--surface-2),transparent_70%)]">
                <LessonWeb web={web} selected={selected} onSelect={setSelected} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11.5px] text-text-tertiary">
                {[
                  { swatch: <span className="h-2.5 w-2.5 rounded-full" style={{ background: CHART.profit }} />, text: "di aturan ULANGI" },
                  { swatch: <span className="h-2.5 w-2.5 rounded-full" style={{ background: CHART.loss }} />, text: "di aturan HINDARI" },
                  {
                    swatch: (
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: `conic-gradient(${CHART.profit} 0 180deg, ${CHART.loss} 180deg 360deg)` }}
                      />
                    ),
                    text: "campuran",
                  },
                  { swatch: <span className="h-px w-3.5 bg-text-tertiary" />, text: "muncul bersama" },
                  { swatch: <span className="text-[10px] leading-none">●</span>, text: "besar = sering" },
                ].map((x) => (
                  <span key={x.text} className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1">
                    {x.swatch}
                    {x.text}
                  </span>
                ))}
              </div>
            </section>

            {web.freeText > 0 ? (
              <p className="px-1 text-[12px] leading-relaxed text-text-tertiary [text-wrap:pretty]">
                {web.freeText} aturan lain (yang ditulis atau di-pin manual, atau aturan lama tanpa syarat terukur) tidak ikut dipetakan karena ditulis sebagai
                teks bebas. Semuanya ada di halaman{" "}
                <Link href="/pelajaran" className="text-accent-bright underline-offset-2 hover:underline">
                  Pelajaran
                </Link>
                .
              </p>
            ) : null}
          </div>

          <aside
            ref={panelRef}
            aria-live="polite"
            className="scroll-mt-20 rounded-[var(--radius-xl)] border border-border bg-surface-1 p-4 md:p-5 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6.5rem)] lg:overflow-y-auto"
          >
            {panel}
          </aside>
        </div>
      )}
    </div>
  );
}
