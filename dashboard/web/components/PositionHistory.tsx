"use client";

import { useMemo, useState, Fragment } from "react";
import { CaretRight, ClockCounterClockwise } from "@phosphor-icons/react";
import { Address } from "@/components/Address";
import { EmptyState } from "@/components/states";
import { pnlColorClass } from "@/lib/pnl-color";
import {
  formatPnlPct,
  formatPnlUsd,
  formatUsd,
  formatSol,
  formatPct,
  formatDuration,
  relativeTime,
  absoluteTime,
  shortDateTime,
  compact,
  binPriceRatio,
  formatSignedPct,
  DASH,
} from "@/lib/format";
import type { PerformanceEntry, Decision } from "@/lib/types";

// Closed-position history: lessons.json performance[] joined with the matching
// decision-log deploy entry (by position address) for the open reason.
// decision-log only keeps the last 100 decisions, so older closes may have no
// deploy reason — the row still renders from performance data alone.

export interface HistoryRow {
  perf: PerformanceEntry;
  deploy?: Decision;
}

// Close timestamp comes from performance (recorded_at). Open timestamp is not
// stored there — prefer the deploy decision's ts, else derive close - minutes_held.
export function openCloseTimes(row: HistoryRow): { openTs: number | null; closeTs: number | null } {
  const p = row.perf;
  const closeRaw = p.recorded_at ?? p.closed_at ?? p.ts;
  const closeTs = closeRaw != null ? Date.parse(String(closeRaw)) : NaN;
  const deployTs = row.deploy?.ts != null ? Date.parse(String(row.deploy.ts)) : NaN;
  let openTs = Number.isFinite(deployTs) ? deployTs : NaN;
  if (!Number.isFinite(openTs) && Number.isFinite(closeTs) && Number.isFinite(p.minutes_held ?? NaN)) {
    openTs = closeTs - (p.minutes_held as number) * 60_000;
  }
  return {
    openTs: Number.isFinite(openTs) ? openTs : null,
    closeTs: Number.isFinite(closeTs) ? closeTs : null,
  };
}

function joinHistory(performance: PerformanceEntry[], decisions: Decision[]): HistoryRow[] {
  const deploysByPosition = new Map<string, Decision>();
  for (const d of decisions) {
    if (d.type === "deploy" && d.position) deploysByPosition.set(d.position, d);
  }
  return performance
    .map((perf) => ({
      perf,
      deploy: perf.position ? deploysByPosition.get(perf.position) : undefined,
    }))
    .reverse(); // newest close first
}

function DetailItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className="mt-0.5 text-[12.5px] text-text-secondary break-words">{value ?? DASH}</div>
    </div>
  );
}

function RowDetail({ row }: { row: HistoryRow }) {
  const { perf, deploy } = row;
  const snap = (perf.signal_snapshot ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const range = perf.bin_range;
  const { openTs, closeTs } = openCloseTimes(row);

  // Reference bin: the active bin at deploy (top of range for single-side SOL).
  // Falls back to `range.max` (Meridian's convention: active=upper on entry).
  const refBin =
    (typeof (perf as { active_bin_at_deploy?: number }).active_bin_at_deploy === "number"
      ? (perf as { active_bin_at_deploy?: number }).active_bin_at_deploy
      : range?.max) ?? null;
  const lowerRatio = binPriceRatio(range?.min ?? null, refBin, perf.bin_step ?? null);
  const upperRatio = binPriceRatio(range?.max ?? null, refBin, perf.bin_step ?? null);
  const lowerPct = lowerRatio != null ? (lowerRatio - 1) * 100 : null;
  const upperPct = upperRatio != null ? (upperRatio - 1) * 100 : null;

  const minMcap = perf.entry_mcap != null && lowerRatio != null ? perf.entry_mcap * lowerRatio : null;
  const maxMcap = perf.entry_mcap != null && upperRatio != null ? perf.entry_mcap * upperRatio : null;

  return (
    <div className="flex flex-col gap-3 border-t border-border bg-surface-1 px-4 py-3">
      <div>
        <div className="text-[10.5px] uppercase tracking-wide text-text-tertiary">Open reason</div>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">
          {deploy?.reason || deploy?.summary || "Deploy reason not in decision log (rolls off after 100 entries)."}
        </p>
        {deploy?.risks && deploy.risks.length > 0 && (
          <p className="mt-1 text-[12px] text-text-tertiary">Risks noted at deploy: {deploy.risks.join(" · ")}</p>
        )}
      </div>

      <div>
        <div className="text-[10.5px] uppercase tracking-wide text-text-tertiary">Close reason</div>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">{perf.close_reason || DASH}</p>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <DetailItem label="Open time" value={<span title={absoluteTime(openTs)}>{shortDateTime(openTs)}</span>} />
        <DetailItem label="Close time" value={<span title={absoluteTime(closeTs)}>{shortDateTime(closeTs)}</span>} />
        <DetailItem label="Size" value={formatSol(perf.amount_sol, 2)} />
        <DetailItem
          label="Range"
          value={range?.min != null && range?.max != null ? `[${range.min}, ${range.max}]` : DASH}
        />
        <DetailItem label="In range" value={`${formatDuration(perf.minutes_in_range)} / ${formatDuration(perf.minutes_held)}`} />
        <DetailItem label="Range efficiency" value={formatPct(perf.range_efficiency, 1)} />
        <DetailItem label="Entry value" value={formatUsd(perf.initial_value_usd)} />
        <DetailItem label="Exit value" value={formatUsd(perf.final_value_usd)} />
        <DetailItem
          label="Net PnL (PnL + fees)"
          value={
            <span className={pnlColorClass((perf.pnl_usd ?? 0) + (perf.fees_earned_usd ?? 0))}>
              {formatPnlUsd((perf.pnl_usd ?? 0) + (perf.fees_earned_usd ?? 0))}
            </span>
          }
        />
        <DetailItem
          label="PnL source"
          value={
            perf.pnl_source === "meteora_closed"
              ? "Meteora (settled)"
              : "Estimate at close"
          }
        />
        <DetailItem label="Mcap in" value={compact(perf.entry_mcap)} />
        <DetailItem label="Mcap out" value={compact(perf.exit_mcap)} />
        <DetailItem
          label="Min price range"
          value={lowerPct != null ? `${formatSignedPct(lowerPct)} vs entry` : DASH}
        />
        <DetailItem
          label="Max price range"
          value={upperPct != null ? `${formatSignedPct(upperPct)} vs entry` : DASH}
        />
        <DetailItem label="Min mcap range" value={compact(minMcap)} />
        <DetailItem label="Max mcap range" value={compact(maxMcap)} />
        <DetailItem
          label="Fee tier · bin step"
          value={
            perf.bin_step != null
              ? `${(perf.bin_step / 100).toFixed(2)}% · ${perf.bin_step} bps`
              : DASH
          }
        />
        <DetailItem label="Organic score" value={num(snap.organic_score) ?? perf.organic_score ?? DASH} />
        <DetailItem label="Fee/TVL at entry" value={perf.fee_tvl_ratio != null ? perf.fee_tvl_ratio.toFixed(4) : DASH} />
        <DetailItem label="Volatility" value={perf.volatility != null ? perf.volatility.toFixed(2) : DASH} />
        <DetailItem
          label="Holders at entry"
          value={
            (() => {
              const h =
                (perf as { holders_at_entry?: number }).holders_at_entry ??
                (num(snap.holder_count) as number | null);
              return h != null ? compact(h) : DASH;
            })()
          }
        />
        <DetailItem
          label="Smart wallets"
          value={
            (() => {
              const s =
                (perf as { smart_wallets_present?: boolean }).smart_wallets_present ??
                (snap.smart_wallets_present as boolean | null | undefined);
              return s == null ? DASH : s ? "present" : "none";
            })()
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-text-tertiary">
        <span>
          Position <Address value={perf.position ?? ""} chars={4} />
        </span>
        <span>
          Pool <Address value={perf.pool ?? ""} chars={4} />
        </span>
      </div>
    </div>
  );
}

function SummaryStat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-surface-1 px-3 py-2">
      <div className="text-[10.5px] uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className={`mt-0.5 font-mono text-[14px] tnum ${className ?? "text-text-primary"}`}>{value}</div>
    </div>
  );
}

export function PositionHistory({
  performance,
  decisions,
}: {
  performance?: PerformanceEntry[];
  decisions?: Decision[];
}) {
  const rows = useMemo(() => joinHistory(performance ?? [], decisions ?? []), [performance, decisions]);
  const [open, setOpen] = useState<string | null>(null);

  const stats = useMemo(() => {
    const wins = rows.filter((r) => (r.perf.pnl_pct ?? 0) > 0).length;
    const totalUsd = rows.reduce((s, r) => s + (r.perf.pnl_usd ?? 0), 0);
    const totalFees = rows.reduce((s, r) => s + (r.perf.fees_earned_usd ?? 0), 0);
    return { count: rows.length, wins, totalUsd, totalFees, netUsd: totalUsd + totalFees };
  }, [rows]);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ClockCounterClockwise}
        title="No closed positions yet."
        hint="History appears here after the first position is closed."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <SummaryStat label="Closed trades" value={String(stats.count)} />
        <SummaryStat label="Win rate" value={formatPct((stats.wins / stats.count) * 100, 1)} />
        <SummaryStat label="Total PnL" value={formatPnlUsd(stats.totalUsd)} className={pnlColorClass(stats.totalUsd)} />
        <SummaryStat label="Fees earned" value={formatUsd(stats.totalFees)} />
        <SummaryStat label="Net PnL (PnL + fees)" value={formatPnlUsd(stats.netUsd)} className={pnlColorClass(stats.netUsd)} />
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-[var(--radius-lg)] border border-border lg:block">
        <table className="w-full min-w-[1000px] border-collapse text-[13px]">
          <thead className="bg-surface-1">
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-text-tertiary">
              <th className="w-8 px-3 py-2.5" />
              <th className="px-3 py-2.5 font-medium">Pool</th>
              <th className="px-3 py-2.5 font-medium">Strategy</th>
              <th className="px-3 py-2.5 text-right font-medium">PnL %</th>
              <th className="px-3 py-2.5 text-right font-medium">PnL $</th>
              <th className="px-3 py-2.5 text-right font-medium">Fees</th>
              <th className="px-3 py-2.5 text-right font-medium">Net PnL</th>
              <th className="px-3 py-2.5 text-right font-medium">Held</th>
              <th className="px-3 py-2.5 font-medium">Close reason</th>
              <th className="px-3 py-2.5 text-right font-medium">Opened</th>
              <th className="px-3 py-2.5 text-right font-medium">Closed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const p = row.perf;
              const key = p.position ?? `${p.pool}-${p.recorded_at}`;
              const isOpen = open === key;
              const { openTs, closeTs } = openCloseTimes(row);
              return (
                <Fragment key={key}>
                  <tr
                    className="cursor-pointer hover:bg-surface-2"
                    onClick={() => setOpen(isOpen ? null : key)}
                  >
                    <td className="px-3 py-2.5">
                      <CaretRight
                        size={14}
                        weight="bold"
                        className={`text-text-tertiary transition-transform ${isOpen ? "rotate-90" : ""}`}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-text-primary">{p.pool_name || DASH}</div>
                      <span onClick={(e) => e.stopPropagation()}>
                        <Address value={p.position ?? ""} chars={4} />
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-text-secondary">{p.strategy || DASH}</td>
                    <td className={`px-3 py-2.5 text-right font-mono tnum ${pnlColorClass(p.pnl_pct)}`}>
                      {formatPnlPct(p.pnl_pct)}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-mono tnum ${pnlColorClass(p.pnl_usd)}`}>
                      {formatPnlUsd(p.pnl_usd)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-text-secondary tnum">
                      {formatUsd(p.fees_earned_usd)}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right font-mono tnum ${pnlColorClass((p.pnl_usd ?? 0) + (p.fees_earned_usd ?? 0))}`}
                    >
                      {formatPnlUsd((p.pnl_usd ?? 0) + (p.fees_earned_usd ?? 0))}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-text-secondary tnum">
                      {formatDuration(p.minutes_held)}
                    </td>
                    <td className="max-w-[240px] truncate px-3 py-2.5 text-text-secondary" title={p.close_reason}>
                      {p.close_reason || DASH}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[12px] text-text-tertiary tnum" title={absoluteTime(openTs)}>
                      {shortDateTime(openTs)}
                    </td>
                    <td
                      className="px-3 py-2.5 text-right font-mono text-[12px] text-text-tertiary tnum"
                      title={`${absoluteTime(closeTs)} (${relativeTime(closeTs)})`}
                    >
                      {shortDateTime(closeTs)}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={11} className="p-0">
                        <RowDetail row={row} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="flex flex-col gap-3 lg:hidden">
        {rows.map((row) => {
          const p = row.perf;
          const key = p.position ?? `${p.pool}-${p.recorded_at}`;
          const { openTs, closeTs } = openCloseTimes(row);
          return (
            <details key={key} className="group rounded-[var(--radius-md)] border border-border bg-surface-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-medium text-text-primary">{p.pool_name || DASH}</div>
                  <div className="mt-0.5 text-[11.5px] text-text-tertiary">
                    {p.strategy || DASH} · {formatDuration(p.minutes_held)}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-text-tertiary tnum">
                    {shortDateTime(openTs)} → {shortDateTime(closeTs)}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`font-mono text-[13.5px] tnum ${pnlColorClass(p.pnl_pct)}`}>{formatPnlPct(p.pnl_pct)}</div>
                  <div className={`font-mono text-[11.5px] tnum ${pnlColorClass(p.pnl_usd)}`}>{formatPnlUsd(p.pnl_usd)}</div>
                  <div
                    className={`font-mono text-[11px] tnum ${pnlColorClass((p.pnl_usd ?? 0) + (p.fees_earned_usd ?? 0))}`}
                  >
                    net {formatPnlUsd((p.pnl_usd ?? 0) + (p.fees_earned_usd ?? 0))}
                  </div>
                </div>
              </summary>
              <RowDetail row={row} />
            </details>
          );
        })}
      </div>
    </div>
  );
}
