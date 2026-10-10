"use client";

import { useMemo } from "react";
import { Badge } from "./ui/Badge";
import { EmptyState } from "./states";
import { relativeTime } from "@/lib/format";

// Local shapes — only the fields this view reads. Mirrors src/domain/schemas/lesson.ts
// (Lesson.stats, PerformanceRecord.review / entry_reason / lessons_applied).
interface LoopLesson {
  id: string | number;
  rule: string;
  pinned?: boolean;
  sourceType?: string | null;
  stats?: { applied: number; wins: number; losses: number; last_applied_at?: string | null };
}

interface LoopReview {
  reviewed_at: string;
  outcome: "win" | "loss";
  net_usd?: number | null;
  pnl_source?: string | null;
  what?: string | null;
  why?: string | null;
  lesson_id?: string | null;
  lesson_rule?: string | null;
  lessons_applied?: Array<{ id: string; rule: string | null }>;
  note?: string | null;
}

interface LoopRecord {
  position?: string;
  pool_name?: string | null;
  pool?: string;
  pnl_pct?: number;
  strategy?: string;
  closed_at?: string | null;
  entry_reason?: string | null;
  lessons_applied?: string[] | null;
  review?: LoopReview;
}

/** Same selection as src/domain/prompt/lessons.ts selectPromptLessons. */
const RECENT_UNPINNED_IN_PROMPT = 8;

const NOTE_TEXT: Record<string, string> = {
  llm_none: "nothing new beyond existing lessons",
  llm_failed: "LLM failed — outcome still scored",
  llm_unavailable: "no LLM configured — outcome still scored",
};

function TrackRecord({ stats }: { stats?: LoopLesson["stats"] }) {
  if (!stats || stats.applied <= 0) return <span className="text-text-tertiary">not cited yet</span>;
  const tone = stats.wins > stats.losses ? "profit" : stats.wins < stats.losses ? "loss" : "neutral";
  return (
    <Badge tone={tone} mono>
      {stats.applied}x · {stats.wins}W/{stats.losses}L
    </Badge>
  );
}

export function LearningLoop({
  lessons = [],
  performance = [],
}: {
  lessons?: LoopLesson[];
  performance?: LoopRecord[];
}) {
  const inPrompt = useMemo(() => {
    const newestFirst = [...lessons].reverse();
    return {
      pinned: newestFirst.filter((l) => l.pinned),
      recent: newestFirst.filter((l) => !l.pinned).slice(0, RECENT_UNPINNED_IN_PROMPT),
    };
  }, [lessons]);

  const reviews = useMemo(
    () => performance.filter((p) => p.review).slice(-20).reverse(),
    [performance],
  );
  const pendingCount = performance.filter((p) => !p.review && p.closed_at && Date.now() - Date.parse(p.closed_at) < 24 * 3600_000).length;

  const promptRows = [
    ...inPrompt.pinned.map((l) => ({ l, kind: "pinned" as const })),
    ...inPrompt.recent.map((l) => ({ l, kind: "recent" as const })),
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="mb-1 text-[13px] font-semibold text-text-primary">
          What the screener reads before every deploy
        </h3>
        <p className="mb-3 text-[12px] text-text-tertiary">
          All pinned lessons + the {RECENT_UNPINNED_IN_PROMPT} newest unpinned ones go into the LESSONS block of the prompt.
          When it deploys, the AI cites the ids it used; after the close those lessons are scored W/L.
        </p>
        {promptRows.length === 0 ? (
          <EmptyState title="No lessons yet" />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {promptRows.map(({ l, kind }) => (
              <li key={String(l.id)} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-3">
                <div className="flex shrink-0 items-center gap-1.5 sm:w-44">
                  <Badge tone={kind === "pinned" ? "accent" : "neutral"}>{kind}</Badge>
                  {l.sourceType === "close-review" ? <Badge tone="warning">auto</Badge> : null}
                </div>
                <p className="min-w-0 flex-1 break-words text-[13px] text-text-secondary">{l.rule}</p>
                <div className="shrink-0 text-[12px]">
                  <TrackRecord stats={l.stats} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-[13px] font-semibold text-text-primary">What it learned from each close</h3>
        <p className="mb-3 text-[12px] text-text-tertiary">
          Reviewed once Meteora settles the PnL (or after 20 min).
          {pendingCount > 0 ? ` ${pendingCount} recent close(s) waiting for review.` : ""}
        </p>
        {reviews.length === 0 ? (
          <EmptyState title="No reviewed closes yet" />
        ) : (
          <ul className="flex flex-col gap-3">
            {reviews.map((p) => {
              const r = p.review!;
              const pnl = p.pnl_pct ?? 0;
              return (
                <li key={p.position} className="rounded-[var(--radius-md)] border border-border bg-surface-2 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-text-primary">{p.pool_name ?? p.pool?.slice(0, 8)}</span>
                    <Badge tone={r.outcome === "win" ? "profit" : "loss"}>{r.outcome.toUpperCase()}</Badge>
                    <Badge tone={pnl >= 0 ? "profit" : "loss"} mono>
                      {pnl >= 0 ? "+" : ""}
                      {pnl.toFixed(2)}%{r.net_usd != null ? ` · $${r.net_usd.toFixed(2)}` : ""}
                    </Badge>
                    {p.strategy ? <Badge>{p.strategy}</Badge> : null}
                    <span className="ml-auto text-[12px] text-text-tertiary">{relativeTime(p.closed_at ?? r.reviewed_at)}</span>
                  </div>
                  <dl className="grid gap-1 text-[12px] sm:grid-cols-[110px_1fr]">
                    {p.entry_reason ? (
                      <>
                        <dt className="text-text-tertiary">Entry reason</dt>
                        <dd className="break-words text-text-secondary">{p.entry_reason}</dd>
                      </>
                    ) : null}
                    <dt className="text-text-tertiary">Lessons used</dt>
                    <dd className="break-words text-text-secondary">
                      {r.lessons_applied?.length
                        ? r.lessons_applied.map((a) => (
                            <span key={a.id} className="mr-2 inline-block">
                              <code className="text-[11px]">{a.id}</code>
                              {a.rule ? "" : " (deleted)"}
                            </span>
                          ))
                        : "none cited"}
                    </dd>
                    {r.what ? (
                      <>
                        <dt className="text-text-tertiary">What happened</dt>
                        <dd className="break-words text-text-secondary">{r.what}</dd>
                      </>
                    ) : null}
                    {r.why ? (
                      <>
                        <dt className="text-text-tertiary">Why</dt>
                        <dd className="break-words text-text-secondary">{r.why}</dd>
                      </>
                    ) : null}
                    <dt className="text-text-tertiary">New lesson</dt>
                    <dd className="break-words text-text-primary">
                      {r.lesson_rule ?? <span className="text-text-tertiary">none ({NOTE_TEXT[r.note ?? ""] ?? r.note ?? "—"})</span>}
                    </dd>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
