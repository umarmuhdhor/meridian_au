"use client";

import { useMemo, useState } from "react";
import {
  Lightbulb,
  PushPin,
  CheckCircle,
  Prohibit,
  CaretDown,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { useFile } from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmModal } from "@/components/ConfirmModal";
import { useDaemonStatus } from "@/components/DaemonStatus";
import { LearningCurve } from "@/components/LearningCurve";
import { SkeletonRows, EmptyState, ErrorState } from "@/components/states";
import { relativeTime, shortDateTime, formatDuration } from "@/lib/format";
import { CHART } from "@/lib/chart";
import { cn } from "@/lib/cn";
import { plainLesson, stripAutoPrefix, techChips, tfLabel, type PlainLesson, type TechLike } from "@/lib/lesson-plain";

// ── Local shapes (only what this page reads) — mirror src/domain/schemas/lesson.ts ──

interface Stats {
  applied: number;
  wins: number;
  losses: number;
}

interface Lesson {
  id: string;
  rule: string;
  pinned?: boolean;
  outcome?: string | null;
  sourceType?: string | null;
  tags?: string[];
  stats?: Stats;
  created_at?: string;
  context?: Record<string, unknown> | null;
  match?: string | null;
  backtest?: { wins: number; losses: number } | null;
}

interface Review {
  reviewed_at: string;
  outcome: "win" | "loss";
  net_usd?: number | null;
  what?: string | null;
  why?: string | null;
  lesson_id?: string | null;
  lesson_rule?: string | null;
  lessons_applied?: Array<{ id: string; rule: string | null }>;
  note?: string | null;
}

interface Perf {
  position: string;
  pool?: string;
  pool_name?: string | null;
  pnl_pct: number;
  pnl_usd?: number;
  fees_earned_usd?: number;
  pnl_source?: string;
  minutes_held?: number;
  close_reason?: string;
  amount_sol?: number;
  strategy?: string;
  closed_at?: string | null;
  recorded_at?: string;
  entry_reason?: string | null;
  lessons_applied?: string[] | null;
  entry_technicals?: TechLike[] | null;
  exit_technicals?: TechLike[] | null;
  review?: Review;
}

interface Decision {
  type?: string;
  position?: string | null;
  reason?: string | null;
}

// Same selection as src/domain/prompt/lessons.ts + screening/cycle.ts: pinned always, the newest 8
// unpinned free-text lessons; unpinned MATCH lessons skip that window and are checked per candidate.
const RECENT_UNPINNED_IN_PROMPT = 8;
const REVIEW_LOOKBACK_MS = 24 * 3600_000;
const PAGE = 20;
const LESSONS_SHOWN = 5;

const NOTE_TEXT: Record<string, string> = {
  llm_none: "AI menilai tidak ada hal baru di luar aturan yang sudah ada",
  llm_failed: "AI gagal menjawab (skor aturan tetap dihitung)",
  llm_unavailable: "AI tidak tersedia (skor aturan tetap dihitung)",
  rule_too_broad: "aturan yang diusulkan terlalu luas (akan memblokir koin bagus), jadi dibuang",
};

const pct = (n: number | null | undefined, digits = 1) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
const usd = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;

const netOf = (p: Perf) => p.review?.net_usd ?? (p.pnl_usd != null ? p.pnl_usd + (p.fees_earned_usd ?? 0) : null);
const outcomeOf = (p: Perf) => p.review?.outcome ?? (p.pnl_pct > 0 ? "win" : "loss");

// ── Small building blocks ──

function Section({ title, hint, children, right }: { title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-border bg-surface-1 p-4">
      <div className="mb-3 flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-text-primary">{title}</h2>
          {hint ? <p className="mt-0.5 text-[12px] text-text-tertiary">{hint}</p> : null}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Green/red split bar — the one visual used everywhere a win/loss count appears. */
function WinLossBar({ wins, losses, height = 8 }: { wins: number; losses: number; height?: number }) {
  const total = wins + losses;
  if (total === 0) return <div className="w-full rounded-full bg-surface-3" style={{ height }} />;
  return (
    <div className="flex w-full overflow-hidden rounded-full" style={{ height }}>
      {wins > 0 && <div style={{ width: `${(wins / total) * 100}%`, background: CHART.profit }} />}
      {losses > 0 && <div style={{ width: `${(losses / total) * 100}%`, background: CHART.loss }} />}
    </div>
  );
}

function PromptStatus({ lesson, inPrompt }: { lesson?: Lesson; inPrompt: Set<string> }) {
  if (!lesson) return <Badge tone="warning">aturan sudah dihapus</Badge>;
  if (lesson.pinned)
    return (
      <Badge tone="accent">
        <PushPin size={11} weight="fill" /> dipin — selalu dibaca AI
      </Badge>
    );
  if (lesson.match) return <Badge tone="accent">aktif — dicek tiap koin</Badge>;
  if (inPrompt.has(String(lesson.id))) return <Badge tone="accent">sedang dibaca AI</Badge>;
  return <Badge tone="warning">sudah tergeser</Badge>;
}

function UsageLine({ stats }: { stats?: Stats }) {
  if (!stats || stats.applied <= 0) return <span className="text-[12px] text-text-tertiary">Belum pernah dipakai saat deploy</span>;
  return (
    <span className="text-[12px] text-text-secondary">
      Dipakai {stats.applied}× → <span className="text-profit">{stats.wins} untung</span> ·{" "}
      <span className="text-loss">{stats.losses} rugi</span>
    </span>
  );
}

/** Condition checklist ("all must hold"), or the plain rule text for free-text lessons. */
function ConditionList({ plain, compact }: { plain: PlainLesson; compact?: boolean }) {
  if (!plain.conditions.length) {
    return <p className={cn("break-words text-text-secondary", compact ? "line-clamp-2 text-[12px]" : "text-[13px]")}>{plain.text}</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {plain.conditions.map((c, i) => (
        <li key={i} className="flex items-start gap-2 text-[13px]" title={c.raw}>
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-text-tertiary" />
          <span className="min-w-0">
            <span className="font-medium text-text-primary">{c.gist}</span>
            {c.detail && !compact ? <span className="text-text-tertiary"> — {c.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

const gistLine = (plain: PlainLesson) =>
  plain.conditions.length ? plain.conditions.map((c) => c.gist).join(" + ") : plain.text;

function TechChips({ rows }: { rows?: TechLike[] | null }) {
  if (!rows?.length) return <span className="text-[12px] text-text-tertiary">tidak tercatat</span>;
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((t) => {
        const chips = techChips(t);
        return (
          <div key={t.timeframe} className="flex flex-wrap items-center gap-1">
            <span className="w-16 shrink-0 text-[11px] text-text-tertiary">{tfLabel(t.timeframe)}</span>
            {chips.length ? chips.map((c, i) => <Badge key={i} tone={c.tone}>{c.text}</Badge>) : <span className="text-[12px] text-text-tertiary">—</span>}
          </div>
        );
      })}
    </div>
  );
}

// ── Page ──

type Filter = "all" | "win" | "loss" | "pending";

export default function PelajaranPage() {
  const lessonsQ = useFile<{ lessons?: Lesson[]; performance?: Perf[] }>("lessons");
  const decisionsQ = useFile<{ decisions?: Decision[] }>("decision-log");
  const followQ = useFile<{ mirrored?: Array<{ position: string }> }>("follow-state");
  const { online } = useDaemonStatus();

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showAllWin, setShowAllWin] = useState(false);
  const [showAllLoss, setShowAllLoss] = useState(false);
  const [pinTarget, setPinTarget] = useState<Lesson | null>(null);

  const lessons = lessonsQ.data?.lessons ?? [];
  const performance = lessonsQ.data?.performance ?? [];

  const byId = useMemo(() => new Map(lessons.map((l) => [String(l.id), l])), [lessons]);
  const plainById = useMemo(() => new Map(lessons.map((l) => [String(l.id), plainLesson(l.rule, l.match)])), [lessons]);

  const inPrompt = useMemo(() => {
    const newestFirst = [...lessons].reverse();
    const ids = new Set<string>();
    newestFirst.filter((l) => l.pinned).forEach((l) => ids.add(String(l.id)));
    newestFirst
      .filter((l) => !l.pinned && !l.match)
      .slice(0, RECENT_UNPINNED_IN_PROMPT)
      .forEach((l) => ids.add(String(l.id)));
    return ids;
  }, [lessons]);

  // Deploy reasons for closes recorded before entry_reason existed.
  const deployReason = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of decisionsQ.data?.decisions ?? []) {
      if (d.type === "deploy" && d.position && d.reason && !m.has(d.position)) m.set(d.position, d.reason);
    }
    return m;
  }, [decisionsQ.data]);

  const mirrored = useMemo(() => new Set((followQ.data?.mirrored ?? []).map((m) => m.position)), [followQ.data]);

  const autoLessons = useMemo(() => lessons.filter((l) => l.sourceType === "close-review").reverse(), [lessons]);
  const fromWins = autoLessons.filter((l) => l.outcome === "win");
  const fromLosses = autoLessons.filter((l) => l.outcome === "loss");

  const scored = useMemo(
    () =>
      lessons
        .filter((l) => (l.stats?.applied ?? 0) > 0)
        .sort((a, b) => b.stats!.applied - a.stats!.applied || b.stats!.wins - a.stats!.wins),
    [lessons]
  );

  const now = Date.now();
  const closedMs = (p: Perf) => Date.parse(String(p.closed_at ?? p.recorded_at));
  const isPending = (p: Perf) => !p.review && !mirrored.has(p.position) && now - closedMs(p) < REVIEW_LOOKBACK_MS;

  const newestFirst = useMemo(() => [...performance].reverse(), [performance]);
  const reviewed = performance.filter((p) => p.review);
  const wins = reviewed.filter((p) => p.review!.outcome === "win").length;
  const losses = reviewed.length - wins;
  const netWin = reviewed.filter((p) => p.review!.outcome === "win").reduce((s, p) => s + (netOf(p) ?? 0), 0);
  const netLoss = reviewed.filter((p) => p.review!.outcome === "loss").reduce((s, p) => s + (netOf(p) ?? 0), 0);
  const pendingCount = performance.filter(isPending).length;

  const filtered = newestFirst.filter((p) => {
    const outcome = outcomeOf(p);
    if (filter === "win" && outcome !== "win") return false;
    if (filter === "loss" && outcome !== "loss") return false;
    if (filter === "pending" && !isPending(p)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [p.pool_name, p.pool, p.position, p.review?.lesson_rule, p.review?.why, p.entry_reason]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(q);
  });

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (lessonsQ.isLoading) return <SkeletonRows rows={8} />;
  if (lessonsQ.isError) return <ErrorState message="Gagal memuat lessons.json." onRetry={() => lessonsQ.refetch()} />;

  const lessonCard = (l: Lesson) => {
    const plain = plainById.get(String(l.id))!;
    const pool = typeof l.context?.pool_name === "string" ? l.context.pool_name : null;
    const pnl = typeof l.context?.pnl_pct === "number" ? l.context.pnl_pct : null;
    return (
      <li key={l.id} className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-border bg-surface-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-text-tertiary">
          <span>Belajar dari</span>
          {pool ? <span className="font-medium text-text-primary">{pool}</span> : null}
          {pnl != null ? (
            <Badge tone={pnl > 0 ? "profit" : "loss"} mono>
              {pct(pnl, 1)}
            </Badge>
          ) : null}
          <span>· {relativeTime(l.created_at)}</span>
          <span className="ml-auto">
            <PromptStatus lesson={l} inPrompt={inPrompt} />
          </span>
        </div>
        <ConditionList plain={plain} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2">
          <UsageLine stats={l.stats} />
          {l.backtest ? (
            <span className="text-[12px] text-text-tertiary" title="Berapa posisi lama yang cocok dengan syarat ini">
              Posisi lama yang mirip: {l.backtest.wins} untung · {l.backtest.losses} rugi
            </span>
          ) : null}
          {!l.pinned && (
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[12px]" disabled={!online} onClick={() => setPinTarget(l)}>
              <PushPin size={12} /> Pin
            </Button>
          )}
        </div>
        {plain.explanation ? (
          <details className="text-[12px]">
            <summary className="cursor-pointer text-text-tertiary hover:text-text-secondary">Penjelasan AI</summary>
            <p className="mt-1 break-words text-text-secondary">{plain.explanation}</p>
          </details>
        ) : null}
      </li>
    );
  };

  const lessonColumn = (
    kind: "win" | "loss",
    list: Lesson[],
    showAll: boolean,
    setShowAll: (b: boolean) => void
  ) => {
    const win = kind === "win";
    const Icon = win ? CheckCircle : Prohibit;
    return (
      <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-surface-1 p-4">
        <div className="flex items-start gap-2">
          <Icon size={22} weight="fill" style={{ color: win ? CHART.profit : CHART.loss }} className="mt-0.5 shrink-0" />
          <div>
            <h2 className="text-[15px] font-semibold text-text-primary">
              {win ? "AI akan MENGULANGI kalau…" : "AI akan MENGHINDARI kalau…"}
            </h2>
            <p className="text-[12px] text-text-tertiary">
              {win ? "Dipelajari dari posisi untung." : "Dipelajari dari posisi rugi."} Semua syarat di satu kartu harus terpenuhi
              bersamaan. Terbaru di atas.
            </p>
          </div>
        </div>
        {list.length ? (
          <>
            <ul className="flex flex-col gap-2">{(showAll ? list : list.slice(0, LESSONS_SHOWN)).map(lessonCard)}</ul>
            {list.length > LESSONS_SHOWN ? (
              <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
                {showAll ? "Tampilkan lebih sedikit" : `Tampilkan semua (${list.length})`}
              </Button>
            ) : null}
          </>
        ) : (
          <EmptyState title="Belum ada" hint={`Muncul setelah posisi ${win ? "untung" : "rugi"} pertama di-review.`} />
        )}
      </section>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-2">
        <Lightbulb size={20} className="mt-0.5 text-accent-bright" />
        <div>
          <h1 className="text-[15px] font-semibold text-text-primary">Apa yang AI pelajari dari untung &amp; rugi</h1>
          <p className="max-w-[80ch] text-[12px] text-text-tertiary">
            Setiap posisi yang ditutup diperiksa ulang oleh AI. Dari situ AI menulis satu aturan: kondisi chart yang perlu
            <b className="text-profit"> diulangi</b> (dari posisi untung) atau
            <b className="text-loss"> dihindari</b> (dari posisi rugi). Aturan itu dibaca AI sebelum membuka posisi berikutnya.
          </p>
        </div>
      </div>

      {/* ── Rapor ── */}
      <section className="grid gap-4 rounded-[var(--radius-lg)] border border-border bg-surface-1 p-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-3">
          <div className="text-[12px] text-text-tertiary">Hasil posisi yang sudah diperiksa AI</div>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div>
              <span className="text-[28px] font-semibold tnum text-profit">{wins}</span>
              <span className="ml-1.5 text-[13px] text-text-secondary">untung</span>
              <span className="ml-2 font-mono text-[12px] tnum text-profit">{usd(netWin)}</span>
            </div>
            <div>
              <span className="text-[28px] font-semibold tnum text-loss">{losses}</span>
              <span className="ml-1.5 text-[13px] text-text-secondary">rugi</span>
              <span className="ml-2 font-mono text-[12px] tnum text-loss">{usd(netLoss)}</span>
            </div>
            <div className="text-[13px] text-text-secondary">
              Total bersih{" "}
              <b className={cn("font-mono tnum", netWin + netLoss >= 0 ? "text-profit" : "text-loss")}>{usd(netWin + netLoss)}</b>
            </div>
          </div>
          <WinLossBar wins={wins} losses={losses} height={14} />
        </div>
        <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
          {[
            { n: fromWins.length, label: "aturan untuk diulangi", color: CHART.profit },
            { n: fromLosses.length, label: "aturan untuk dihindari", color: CHART.loss },
            { n: pendingCount, label: "posisi menunggu diperiksa", color: CHART.neutral },
          ].map((s) => (
            <div key={s.label} className="flex items-center gap-3 rounded-[var(--radius-md)] bg-surface-2 px-3 py-2">
              <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: s.color }} />
              <div>
                <div className="text-[20px] font-semibold leading-6 tnum text-text-primary">{s.n}</div>
                <div className="text-[11px] leading-4 text-text-tertiary">{s.label}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Learning curve ── */}
      <LearningCurve performance={performance} />

      {/* ── Lessons ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {lessonColumn("win", fromWins, showAllWin, setShowAllWin)}
        {lessonColumn("loss", fromLosses, showAllLoss, setShowAllLoss)}
      </div>

      {/* ── Track record ── */}
      <Section
        title="Aturan mana yang benar-benar membantu?"
        hint="Aturan yang disebut AI saat membuka posisi, dan hasil posisi-posisi itu. Banyak merah = aturan itu layak dihapus atau diperbaiki."
        right={
          <div className="flex items-center gap-3 text-[11px] text-text-tertiary">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: CHART.profit }} /> untung
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: CHART.loss }} /> rugi
            </span>
          </div>
        }
      >
        {scored.length ? (
          <ul className="flex flex-col">
            {scored.map((l) => {
              const s = l.stats!;
              const plain = plainById.get(String(l.id))!;
              const winRate = Math.round((s.wins / s.applied) * 100);
              return (
                <li key={l.id} className="grid gap-1.5 border-b border-border py-2.5 last:border-b-0 md:grid-cols-[1fr_240px] md:items-center md:gap-4">
                  <p className="line-clamp-2 min-w-0 break-words text-[13px] text-text-secondary" title={stripAutoPrefix(l.rule)}>
                    {plain.action ? (
                      <span className={cn("mr-1.5 text-[11px] font-semibold", plain.action === "ULANGI" ? "text-profit" : "text-loss")}>
                        {plain.action}
                      </span>
                    ) : l.pinned ? (
                      <PushPin size={12} weight="fill" className="mr-1 inline text-accent-bright" />
                    ) : null}
                    {gistLine(plain)}
                  </p>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <WinLossBar wins={s.wins} losses={s.losses} height={10} />
                    </div>
                    <span className="w-[92px] shrink-0 text-right font-mono text-[12px] tnum text-text-secondary">
                      {s.wins}✓ {s.losses}✗ · {winRate}%
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="Belum ada aturan yang dipakai" hint="Terisi setelah AI membuka posisi sambil menyebut aturan, lalu posisinya ditutup." />
        )}
      </Section>

      {/* ── Per-position story ── */}
      <Section title="Cerita per posisi" hint="Klik satu posisi untuk melihat alasan buka, kenapa ditutup, dan apa yang dipelajari. Terbaru di atas.">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(
            [
              ["all", "Semua"],
              ["win", "Untung"],
              ["loss", "Rugi"],
              ["pending", "Menunggu review"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => {
                setFilter(k);
                setShown(PAGE);
              }}
              className={cn(
                "h-8 rounded-[var(--radius-md)] border px-3 text-[13px]",
                filter === k ? "border-accent-bright bg-surface-2 text-text-primary" : "border-border-strong text-text-secondary hover:text-text-primary"
              )}
            >
              {label}
            </button>
          ))}
          <label className="relative w-full sm:ml-auto sm:w-64">
            <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE);
              }}
              placeholder="Cari coin, alasan, pelajaran…"
              aria-label="Cari posisi"
              className="h-8 w-full rounded-[var(--radius-md)] border border-border-strong bg-surface-2 pl-8 pr-2 text-[13px] text-text-primary"
            />
          </label>
        </div>

        {filtered.length === 0 ? (
          <EmptyState title="Tidak ada posisi yang cocok" />
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.slice(0, shown).map((p) => {
              const r = p.review;
              const outcome = outcomeOf(p);
              const win = outcome === "win";
              const net = netOf(p);
              const isOpen = open.has(p.position);
              const newLesson = r?.lesson_id ? byId.get(r.lesson_id) : undefined;
              const newPlain = r?.lesson_id
                ? plainById.get(r.lesson_id) ?? (r.lesson_rule ? plainLesson(r.lesson_rule) : undefined)
                : undefined;
              const summary = newPlain ? (
                <>
                  <b className={newPlain.action === "HINDARI" ? "text-loss" : newPlain.action === "ULANGI" ? "text-profit" : ""}>
                    {newPlain.action ?? "Aturan baru"}:
                  </b>{" "}
                  {gistLine(newPlain)}
                </>
              ) : r ? (
                <span className="text-text-tertiary">Tidak ada aturan baru</span>
              ) : mirrored.has(p.position) ? (
                <span className="text-text-tertiary">Posisi mirror (follow-the-wallet)</span>
              ) : isPending(p) ? (
                <span className="text-text-tertiary">Menunggu diperiksa AI…</span>
              ) : (
                <span className="text-text-tertiary">Tidak diperiksa</span>
              );

              return (
                <li
                  key={p.position}
                  className="overflow-hidden rounded-[var(--radius-md)] border border-border bg-surface-2"
                  style={{ borderLeft: `3px solid ${win ? CHART.profit : CHART.loss}` }}
                >
                  <button
                    onClick={() => toggle(p.position)}
                    aria-expanded={isOpen}
                    className="flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-surface-3"
                  >
                    <div className="flex w-full flex-wrap items-center gap-2">
                      <span className="text-[14px] font-semibold text-text-primary">{p.pool_name ?? p.pool?.slice(0, 8)}</span>
                      <Badge tone={win ? "profit" : "loss"} mono>
                        {pct(p.pnl_pct, 2)}
                        {net != null ? ` · ${usd(net)}` : ""}
                      </Badge>
                      {p.minutes_held != null ? <span className="text-[12px] text-text-tertiary">ditahan {formatDuration(p.minutes_held)}</span> : null}
                      {p.pnl_source !== "meteora_closed" ? <Badge tone="warning">PnL estimasi</Badge> : null}
                      <span className="ml-auto flex items-center gap-2 text-[12px] text-text-tertiary" title={shortDateTime(p.closed_at)}>
                        {relativeTime(p.closed_at ?? p.recorded_at)}
                        <CaretDown size={14} className={cn("transition-transform", isOpen && "rotate-180")} />
                      </span>
                    </div>
                    <div className="line-clamp-1 text-[12px] text-text-secondary">
                      <Lightbulb size={12} className="mr-1 inline text-text-tertiary" />
                      {summary}
                    </div>
                  </button>

                  {isOpen ? (
                    <div className="grid gap-3 border-t border-border p-3 md:grid-cols-3">
                      <Step n={1} title="Kenapa dibuka">
                        <p className="break-words text-[12px] text-text-secondary">
                          {p.entry_reason ?? deployReason.get(p.position) ?? <span className="text-text-tertiary">Alasan tidak tercatat.</span>}
                        </p>
                        <div>
                          <div className="mb-1 text-[11px] text-text-tertiary">Kondisi chart saat buka</div>
                          <TechChips rows={p.entry_technicals} />
                        </div>
                        <AppliedLessons p={p} byId={byId} plainById={plainById} />
                      </Step>

                      <Step n={2} title="Kenapa ditutup">
                        <p className="break-words text-[12px] text-text-secondary">{p.close_reason ?? "—"}</p>
                        {r?.what ? <p className="break-words text-[12px] text-text-secondary">{r.what}</p> : null}
                        <div>
                          <div className="mb-1 text-[11px] text-text-tertiary">Kondisi chart saat tutup</div>
                          <TechChips rows={p.exit_technicals} />
                        </div>
                      </Step>

                      <Step n={3} title="Yang dipelajari" highlight={win ? "profit" : "loss"}>
                        {r ? (
                          <>
                            {r.why ? (
                              <p className="break-words text-[12px] text-text-secondary">
                                <span className="text-text-tertiary">Kenapa {win ? "untung" : "rugi"}: </span>
                                {r.why}
                              </p>
                            ) : null}
                            {newPlain ? (
                              <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-surface-1 p-2.5">
                                <div className={cn("text-[12px] font-semibold", newPlain.action === "HINDARI" ? "text-loss" : "text-profit")}>
                                  {newPlain.action === "HINDARI" ? "Lain kali HINDARI kalau:" : newPlain.action === "ULANGI" ? "Lain kali ULANGI kalau:" : "Aturan baru:"}
                                </div>
                                <ConditionList plain={newPlain} />
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <PromptStatus lesson={newLesson} inPrompt={inPrompt} />
                                  {newLesson && !newLesson.pinned ? (
                                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" disabled={!online} onClick={() => setPinTarget(newLesson)}>
                                      <PushPin size={12} /> Pin
                                    </Button>
                                  ) : null}
                                </div>
                              </div>
                            ) : (
                              <p className="text-[12px] text-text-tertiary">
                                Tidak ada aturan baru — {NOTE_TEXT[r.note ?? ""] ?? r.note ?? "—"}.
                              </p>
                            )}
                          </>
                        ) : mirrored.has(p.position) ? (
                          <p className="text-[12px] text-text-tertiary">
                            Posisi mirror (follow-the-wallet) — pelajarannya ditulis sebagai lesson <code>[follow:…]</code>.
                          </p>
                        ) : isPending(p) ? (
                          <p className="text-[12px] text-text-tertiary">Menunggu diperiksa — berjalan setelah PnL final (maks ~25 menit setelah tutup).</p>
                        ) : (
                          <p className="text-[12px] text-text-tertiary">Tidak diperiksa (ditutup sebelum fitur ini aktif, atau lebih dari 24 jam lalu).</p>
                        )}
                      </Step>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {shown < filtered.length ? (
          <div className="mt-3 flex justify-center">
            <Button size="sm" onClick={() => setShown((n) => n + PAGE)}>
              Tampilkan {Math.min(PAGE, filtered.length - shown)} lagi ({filtered.length - shown} tersisa)
            </Button>
          </div>
        ) : null}
      </Section>

      <ConfirmModal
        open={!!pinTarget}
        onClose={() => setPinTarget(null)}
        title="Pin aturan ini?"
        toolName="pin_lesson"
        args={{ id: pinTarget?.id }}
        variant="primary"
        confirmLabel="Pin"
        invalidateKeys={["lessons"]}
        successMessage="Aturan di-pin."
        fields={pinTarget ? [{ label: "Aturan", value: stripAutoPrefix(pinTarget.rule) }] : []}
        impact="Aturan yang di-pin selalu dibaca AI (tidak tergeser oleh aturan baru)."
      />
    </div>
  );
}

function Step({ n, title, children, highlight }: { n: number; title: string; children: React.ReactNode; highlight?: "profit" | "loss" }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-center gap-2 text-[12px] font-semibold text-text-primary">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]"
          style={{
            background: highlight ? (highlight === "profit" ? "var(--profit-tint)" : "var(--loss-tint)") : "var(--surface-3)",
            color: highlight ? (highlight === "profit" ? CHART.profit : CHART.loss) : CHART.axis,
          }}
        >
          {n}
        </span>
        {title}
      </h3>
      {children}
    </div>
  );
}

function AppliedLessons({ p, byId, plainById }: { p: Perf; byId: Map<string, Lesson>; plainById: Map<string, PlainLesson> }) {
  const applied = p.review?.lessons_applied ?? (p.lessons_applied ?? []).map((id) => ({ id, rule: byId.get(id)?.rule ?? null }));
  return (
    <div>
      <div className="mb-1 text-[11px] text-text-tertiary">Aturan yang AI pakai saat buka</div>
      {applied.length ? (
        <ul className="flex flex-col gap-1">
          {applied.map((a) => {
            const plain = plainById.get(a.id) ?? (a.rule ? plainLesson(a.rule) : undefined);
            return (
              <li key={a.id} className="line-clamp-2 break-words text-[12px] text-text-secondary" title={a.rule ? stripAutoPrefix(a.rule) : undefined}>
                • {plain ? (plain.action ? `${plain.action}: ${gistLine(plain)}` : plain.text) : <span className="text-text-tertiary">(sudah dihapus)</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <span className="text-[12px] text-text-tertiary">tidak menyebut aturan</span>
      )}
    </div>
  );
}
