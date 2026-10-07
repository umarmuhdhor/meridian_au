"use client";

import { useMemo, useState } from "react";
import { CalendarBlank, CaretLeft, CaretRight, CalendarX } from "@phosphor-icons/react";
import { useFile } from "@/lib/hooks";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { SkeletonRows, EmptyState, ErrorState } from "@/components/states";
import { pnlColorClass } from "@/lib/pnl-color";
import { formatPnlUsd, formatPnlPct, formatUsd, formatDuration, formatSol, DASH } from "@/lib/format";
import {
  groupByDay,
  monthGrid,
  summarizeMonth,
  maxAbsNet,
  dayKey,
  dayPct,
  monthKey,
  type DayPnl,
} from "@/lib/pnl-calendar";
import { cn } from "@/lib/cn";
import type { LessonsFile } from "@/lib/types";

// Realised PnL per calendar day (local time), from lessons.json performance[].
// A day's figure = sum over the positions CLOSED that day of pnl_usd + fees — open
// positions are not counted until they close.

const WEEKDAYS = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString("id-ID", { month: "long", year: "numeric" });
}

function longDate(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// Cell tint: stronger for bigger days, relative to the month's largest |net|.
function cellTint(net: number, maxAbs: number): string | undefined {
  if (net === 0 || maxAbs <= 0) return undefined;
  const strength = Math.round(10 + (Math.abs(net) / maxAbs) * 30); // 10%..40%
  const fill = net > 0 ? "var(--profit-fill)" : "var(--loss-fill)";
  return `color-mix(in srgb, ${fill} ${strength}%, transparent)`;
}

// Phone-width cell label: no "$", no cents past $10 — "+3.9", "-16".
function shortPnl(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  const a = Math.abs(n);
  return `${sign}${a < 10 ? a.toFixed(1) : a.toFixed(0)}`;
}

function Stat({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-surface-1 p-3">
      <div className="text-[11px] uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className={cn("mt-1 text-[18px] font-semibold tabular-nums text-text-primary", className)}>{value}</div>
    </div>
  );
}

function DayDetail({ day }: { day: DayPnl }) {
  const pct = dayPct(day);
  return (
    <section className="rounded-[var(--radius-lg)] border border-border bg-surface-1 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold capitalize text-text-primary">{longDate(day.key)}</h2>
        <div className="flex items-baseline gap-2 text-[13px] tabular-nums">
          <span className={cn("font-semibold", pnlColorClass(day.netUsd))}>{formatPnlUsd(day.netUsd)}</span>
          {pct != null && <span className={pnlColorClass(pct)}>{formatPnlPct(pct)}</span>}
          <span className="text-text-tertiary">
            · {day.closes.length} close · {day.wins}W / {day.losses}L · fee {formatUsd(day.feesUsd)}
          </span>
        </div>
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {day.closes.map(({ perf, closeTs, netUsd }, i) => (
          <li key={perf.position ?? i} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13.5px] font-medium text-text-primary">{perf.pool_name ?? perf.pool ?? DASH}</span>
                {perf.strategy && <Badge>{perf.strategy}</Badge>}
                <span className="text-[12px] text-text-tertiary tabular-nums">
                  {timeOf(closeTs)} · {formatSol(perf.amount_sol, 2)} · ditahan {formatDuration(perf.minutes_held)}
                </span>
              </div>
              {perf.close_reason && (
                <p className="mt-0.5 text-[12px] leading-relaxed text-text-tertiary break-words">{perf.close_reason}</p>
              )}
            </div>
            <div className="text-right tabular-nums">
              <div className={cn("text-[13.5px] font-semibold", pnlColorClass(netUsd))}>{formatPnlUsd(netUsd)}</div>
              <div className={cn("text-[12px]", pnlColorClass(perf.pnl_pct))}>{formatPnlPct(perf.pnl_pct)}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function KalenderPage() {
  const lessonsQ = useFile<LessonsFile>("lessons");
  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [selected, setSelected] = useState<string | null>(null);

  const days = useMemo(() => groupByDay(lessonsQ.data?.performance ?? []), [lessonsQ.data]);
  const { year, month } = cursor;
  const cells = useMemo(() => monthGrid(year, month), [year, month]);
  const summary = useMemo(() => summarizeMonth(days, year, month), [days, year, month]);
  const maxAbs = useMemo(() => maxAbsNet(days, year, month), [days, year, month]);

  // Selected day: the clicked one if it's in view, else the latest day with closes this month.
  const prefix = `${monthKey(year, month)}-`;
  const latestInMonth = [...days.keys()].filter((k) => k.startsWith(prefix)).sort().pop() ?? null;
  const activeKey = selected && selected.startsWith(prefix) ? selected : latestInMonth;
  const activeDay = activeKey ? days.get(activeKey) : undefined;
  const todayKey = dayKey(now);

  const shiftMonth = (delta: number) => {
    setSelected(null);
    setCursor(({ year: y, month: m }) => {
      const d = new Date(y, m + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  const winRate = summary.wins + summary.losses > 0 ? (summary.wins / (summary.wins + summary.losses)) * 100 : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <CalendarBlank size={20} className="text-accent-bright" />
        <div>
          <h1 className="text-[15px] font-semibold text-text-primary">Kalender PnL</h1>
          <p className="text-[12px] text-text-tertiary">
            Untung / rugi bersih (PnL + fee) dari posisi yang ditutup setiap hari.
          </p>
        </div>
      </div>

      {lessonsQ.isLoading ? (
        <SkeletonRows rows={6} />
      ) : lessonsQ.isError ? (
        <ErrorState message="Gagal memuat riwayat performa." onRetry={() => lessonsQ.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Net bulan ini"
              value={formatPnlUsd(summary.netUsd)}
              className={pnlColorClass(summary.netUsd)}
            />
            <Stat label="Fee bulan ini" value={formatUsd(summary.feesUsd)} />
            <Stat
              label="Hari hijau / merah"
              value={
                <>
                  <span className="text-profit">{summary.greenDays}</span>
                  <span className="text-text-tertiary"> / </span>
                  <span className="text-loss">{summary.redDays}</span>
                </>
              }
            />
            <Stat
              label="Close · win rate"
              value={`${summary.closes} · ${winRate != null ? `${winRate.toFixed(0)}%` : DASH}`}
            />
          </div>

          <section className="rounded-[var(--radius-lg)] border border-border bg-surface-1 p-3 sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => shiftMonth(-1)} aria-label="Bulan sebelumnya">
                <CaretLeft size={16} />
              </Button>
              <h2 className="text-center text-[15px] font-semibold capitalize text-text-primary">
                {monthLabel(year, month)}
              </h2>
              <div className="flex items-center gap-1">
                {(year !== now.getFullYear() || month !== now.getMonth()) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelected(null);
                      setCursor({ year: now.getFullYear(), month: now.getMonth() });
                    }}
                  >
                    Hari ini
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => shiftMonth(1)} aria-label="Bulan berikutnya">
                  <CaretRight size={16} />
                </Button>
              </div>
            </div>

            {(summary.best || summary.worst) && (
              <p className="-mt-1 mb-3 text-center text-[11.5px] text-text-tertiary tabular-nums">
                {summary.best && (
                  <>
                    terbaik {Number(summary.best.key.slice(8))}{" "}
                    <span className="text-profit">{formatPnlUsd(summary.best.netUsd)}</span>
                  </>
                )}
                {summary.best && summary.worst && " · "}
                {summary.worst && (
                  <>
                    terburuk {Number(summary.worst.key.slice(8))}{" "}
                    <span className="text-loss">{formatPnlUsd(summary.worst.netUsd)}</span>
                  </>
                )}
              </p>
            )}
            <div className="grid grid-cols-7 gap-1 sm:gap-1.5">
              {WEEKDAYS.map((w) => (
                <div key={w} className="pb-1 text-center text-[11px] font-medium uppercase text-text-tertiary">
                  {w}
                </div>
              ))}
              {cells.map((date, i) => {
                if (!date) return <div key={`pad-${i}`} />;
                const key = dayKey(date);
                const day = days.get(key);
                const isActive = key === activeKey;
                const isToday = key === todayKey;
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={!day}
                    onClick={() => setSelected(key)}
                    style={day ? { backgroundColor: cellTint(day.netUsd, maxAbs) } : undefined}
                    className={cn(
                      "flex min-h-[56px] flex-col items-start justify-between rounded-[var(--radius-md)] border p-1 text-left overflow-hidden sm:min-h-[76px] sm:p-2",
                      day ? "cursor-pointer border-border hover:border-accent-bright" : "border-transparent bg-surface-2/40",
                      isActive && "border-accent-bright ring-1 ring-accent-bright",
                    )}
                  >
                    <span
                      className={cn(
                        "text-[11px] tabular-nums sm:text-[12px]",
                        isToday ? "font-semibold text-accent-bright" : "text-text-tertiary",
                      )}
                    >
                      {date.getDate()}
                    </span>
                    {day && (
                      <span className="flex w-full flex-col">
                        <span
                          className={cn(
                            "truncate text-[10px] font-semibold tabular-nums sm:text-[13px]",
                            pnlColorClass(day.netUsd),
                          )}
                        >
                          <span className="sm:hidden">{shortPnl(day.netUsd)}</span>
                          <span className="hidden sm:inline">{formatPnlUsd(day.netUsd)}</span>
                        </span>
                        <span className="hidden text-[11px] text-text-tertiary sm:block">
                          {day.closes.length} close
                        </span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          {activeDay ? (
            <DayDetail day={activeDay} />
          ) : (
            <EmptyState
              icon={CalendarX}
              title="Belum ada posisi yang ditutup di bulan ini."
              hint="Pindah ke bulan lain dengan tombol panah."
            />
          )}
        </>
      )}
    </div>
  );
}
