"use client";

import { Fragment, useState } from "react";
import { CaretRight, ChartLineUp, ArrowSquareOut } from "@phosphor-icons/react";
import { usePositions, useFile } from "@/lib/hooks";
import { meteoraPoolUrl } from "@/lib/meteora";
import { PositionCard } from "@/components/PositionCard";
import { PositionActions } from "@/components/PositionActions";
import { PositionHistory } from "@/components/PositionHistory";
import { StatusBadge } from "@/components/StatusBadge";
import { Address } from "@/components/Address";
import { SkeletonRows, EmptyState, ErrorState } from "@/components/states";
import { pnlColorClass } from "@/lib/pnl-color";
import { openPositionPnl } from "@/lib/position-pnl";
import {
  formatPnlPct,
  formatPnlUsd,
  formatUsd,
  formatSol,
  formatDuration,
  binRange,
  binPriceRatio,
  formatSignedPct,
  compact,
  shortDateTime,
  absoluteTime,
  DASH,
} from "@/lib/format";
import type { Position, LessonsFile, DecisionLogFile } from "@/lib/types";

function rowStatus(p: Position) {
  if (p.in_range === false) {
    return <StatusBadge status="out_of_range" detail={p.minutes_out_of_range != null ? formatDuration(p.minutes_out_of_range) : undefined} />;
  }
  return <StatusBadge status="in_range" />;
}

function DetailItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className="mt-0.5 text-[12.5px] text-text-secondary break-words">{value ?? DASH}</div>
    </div>
  );
}

// Deploy-hook-only fields have no on-chain source. On externally-opened
// positions render "external" (muted) instead of "-" so users know why the cell
// is blank — the position was opened outside Meridian's deploy flow, not that
// tracking broke.
const EXTERNAL_LABEL = <span className="text-text-tertiary italic">external</span>;

function OpenPositionDetail({ p }: { p: Position }) {
  const isExternal = p.source === "external";
  // Reference bin for price ratios: active_bin_at_deploy (top of range for
  // single-side SOL). Falls back to upper_bin.
  const refBin = p.active_bin_at_deploy ?? p.upper_bin ?? null;
  const lowerRatio = binPriceRatio(p.lower_bin ?? null, refBin, p.bin_step ?? null);
  const upperRatio = binPriceRatio(p.upper_bin ?? null, refBin, p.bin_step ?? null);
  const nowRatio = binPriceRatio(p.active_bin ?? null, refBin, p.bin_step ?? null);
  const lowerPct = lowerRatio != null ? (lowerRatio - 1) * 100 : null;
  const upperPct = upperRatio != null ? (upperRatio - 1) * 100 : null;
  const nowPct = nowRatio != null ? (nowRatio - 1) * 100 : null;

  // Prefer entry_mcap as anchor; fall back to current_mcap for positions
  // where Sage didn't record entry_mcap at deploy.
  const mcapAnchor = p.entry_mcap ?? p.current_mcap ?? null;
  const minMcap = mcapAnchor != null && lowerRatio != null ? mcapAnchor * lowerRatio : null;
  const maxMcap = mcapAnchor != null && upperRatio != null ? mcapAnchor * upperRatio : null;
  const nowMcap = p.current_mcap ?? (mcapAnchor != null && nowRatio != null ? mcapAnchor * nowRatio : null);

  // Always derive age from deployed_at when present — server's age_minutes may
  // lag by a poll cycle, and this gives us fresh values on every render.
  const deployedTs = p.deployed_at ? Date.parse(p.deployed_at) : NaN;
  const derivedAge = Number.isFinite(deployedTs)
    ? Math.max(0, Math.round((Date.now() - deployedTs) / 60_000))
    : p.age_minutes ?? null;

  const { pnlUsd: derivedPnlUsd, feesUsd, netUsd } = openPositionPnl(p);

  return (
    <div className="flex flex-col gap-3 border-t border-border bg-surface-1 px-4 py-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <DetailItem
          label="Deployed at"
          value={
            Number.isFinite(deployedTs) ? (
              <span title={absoluteTime(deployedTs)}>
                {shortDateTime(deployedTs)}
                {derivedAge != null && (
                  <span className="ml-1 text-text-tertiary">({formatDuration(derivedAge)})</span>
                )}
              </span>
            ) : (
              DASH
            )
          }
        />
        <DetailItem label="Size" value={formatSol(p.amount_sol_initial ?? null, 2)} />
        <DetailItem label="Entry value" value={formatUsd(p.deposit_usd ?? p.initial_value_usd ?? null)} />
        <DetailItem label="Current value" value={formatUsd(p.total_value_usd ?? null)} />
        <DetailItem
          label="PnL $"
          value={<span className={pnlColorClass(derivedPnlUsd)}>{formatPnlUsd(derivedPnlUsd)}</span>}
        />
        <DetailItem
          label="Fees earned (claimed + unclaimed)"
          value={formatUsd(feesUsd)}
        />
        <DetailItem
          label="Net PnL (PnL + fees)"
          value={<span className={pnlColorClass(netUsd)}>{formatPnlUsd(netUsd)}</span>}
        />
        <DetailItem label="Range (bins)" value={binRange(p.lower_bin ?? null, p.upper_bin ?? null)} />
        <DetailItem
          label="Active bin"
          value={p.active_bin != null ? `${p.active_bin}${nowPct != null ? ` (${formatSignedPct(nowPct)})` : ""}` : DASH}
        />
        <DetailItem
          label="Min price range"
          value={lowerPct != null ? `${formatSignedPct(lowerPct)} vs entry` : DASH}
        />
        <DetailItem
          label="Max price range"
          value={upperPct != null ? `${formatSignedPct(upperPct)} vs entry` : DASH}
        />
        <DetailItem label="Mcap in" value={compact(p.entry_mcap ?? null)} />
        <DetailItem label="Mcap now" value={compact(nowMcap)} />
        <DetailItem label="Min mcap range" value={compact(minMcap)} />
        <DetailItem label="Max mcap range" value={compact(maxMcap)} />
        <DetailItem
          label="Fee tier · bin step"
          value={p.bin_step != null ? `${(p.bin_step / 100).toFixed(2)}% · ${p.bin_step} bps` : DASH}
        />
        <DetailItem label="Organic score" value={p.organic_score != null ? p.organic_score.toFixed(0) : DASH} />
        <DetailItem
          label="Fee/TVL at entry"
          value={p.fee_tvl_ratio != null ? p.fee_tvl_ratio.toFixed(4) : isExternal ? EXTERNAL_LABEL : DASH}
        />
        <DetailItem
          label="Volatility"
          value={p.volatility != null ? p.volatility.toFixed(2) : isExternal ? EXTERNAL_LABEL : DASH}
        />
        <DetailItem
          label="Holders at entry"
          value={p.holders_at_entry != null ? compact(p.holders_at_entry) : DASH}
        />
        <DetailItem
          label="Smart wallets"
          value={
            p.smart_wallets_present == null
              ? isExternal
                ? EXTERNAL_LABEL
                : DASH
              : p.smart_wallets_present
                ? "present"
                : "none"
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-text-tertiary">
        <span>
          Position <Address value={p.position} chars={4} />
        </span>
        <span>
          Pool <Address value={p.pool} chars={4} />
        </span>
      </div>
    </div>
  );
}

function OpenPositions() {
  const q = usePositions();
  const positions: Position[] = q.data?.positions ?? [];
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (q.isError) return <ErrorState message="Failed to load positions." onRetry={() => q.refetch()} />;
  if (positions.length === 0)
    return <EmptyState icon={ChartLineUp} title="No open positions." hint="Run screening from the Screen page to deploy one." />;

  return (
    <div className="flex flex-col gap-4">
      {q.data?.error && (
        <div className="rounded-[var(--radius-md)] border border-border px-3 py-2 text-[12px] text-warning" style={{ backgroundColor: "var(--warning-tint)" }}>
          {q.data.error}
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-[var(--radius-lg)] border border-border lg:block">
        <table className="w-full min-w-[900px] border-collapse text-[13px]">
          <thead className="bg-surface-1">
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-text-tertiary">
              <th className="w-8 px-3 py-2.5" />
              <th className="px-3 py-2.5 font-medium">Pool</th>
              <th className="px-3 py-2.5 font-medium">Strategy</th>
              <th className="px-3 py-2.5 text-right font-medium">Mcap range</th>
              <th className="px-3 py-2.5 text-right font-medium">PnL %</th>
              <th className="px-3 py-2.5 text-right font-medium">PnL $</th>
              <th className="px-3 py-2.5 text-right font-medium">Fee</th>
              <th className="px-3 py-2.5 text-right font-medium">Net PnL</th>
              <th className="px-3 py-2.5 text-right font-medium">Age</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {positions.map((p) => {
              const isOpen = openKey === p.position;
              return (
                <Fragment key={p.position}>
                  <tr
                    className="cursor-pointer hover:bg-surface-2"
                    onClick={() => setOpenKey(isOpen ? null : p.position)}
                  >
                    <td className="px-3 py-2.5">
                      <CaretRight
                        size={14}
                        weight="bold"
                        className={`text-text-tertiary transition-transform ${isOpen ? "rotate-90" : ""}`}
                      />
                    </td>
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      {p.pool ? (
                        <a
                          href={meteoraPoolUrl(p.pool)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open pool on Meteora"
                          className="group inline-flex items-center gap-1 font-medium text-text-primary hover:underline"
                        >
                          {p.pool_name || p.pair || "-"}
                          <ArrowSquareOut size={12} className="text-text-tertiary group-hover:text-text-secondary" />
                        </a>
                      ) : (
                        <div className="font-medium text-text-primary">{p.pool_name || p.pair || "-"}</div>
                      )}
                      <Address value={p.position} chars={4} />
                    </td>
                    <td className="px-3 py-2.5 text-text-secondary">{p.strategy || "-"}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-text-secondary tnum" title={binRange(p.lower_bin ?? null, p.upper_bin ?? null)}>
                      {(() => {
                        // Prefer entry_mcap as anchor (with active_bin_at_deploy as
                        // reference); fall back to current_mcap anchored at active_bin.
                        // Both give a mcap range that reflects the position's bin span.
                        const bs = p.bin_step ?? null;
                        let anchor: number | null = null;
                        let ref: number | null = null;
                        if (p.entry_mcap != null) {
                          anchor = p.entry_mcap;
                          ref = p.active_bin_at_deploy ?? p.upper_bin ?? null;
                        } else if (p.current_mcap != null) {
                          anchor = p.current_mcap;
                          ref = p.active_bin ?? p.upper_bin ?? null;
                        }
                        const lowerR = binPriceRatio(p.lower_bin ?? null, ref, bs);
                        const upperR = binPriceRatio(p.upper_bin ?? null, ref, bs);
                        const lo = anchor != null && lowerR != null ? anchor * lowerR : null;
                        const hi = anchor != null && upperR != null ? anchor * upperR : null;
                        if (lo != null && hi != null) return `${compact(lo)} → ${compact(hi)}`;
                        return binRange(p.lower_bin ?? null, p.upper_bin ?? null);
                      })()}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-mono tnum ${pnlColorClass(p.pnl_pct)}`}>
                      {formatPnlPct(p.pnl_pct)}
                      {p.peak_pnl_pct != null && <div className="text-[11px] text-text-tertiary">peak {formatPnlPct(p.peak_pnl_pct)}</div>}
                    </td>
                    {(() => {
                      const { pnlUsd: derivedPnlUsd, feesUsd, netUsd: net } = openPositionPnl(p);
                      const derivedAge =
                        p.age_minutes ??
                        (p.deployed_at
                          ? Math.max(0, Math.round((Date.now() - Date.parse(p.deployed_at)) / 60_000))
                          : null);
                      return (
                        <>
                          <td className={`px-3 py-2.5 text-right font-mono tnum ${pnlColorClass(derivedPnlUsd)}`}>
                            {formatPnlUsd(derivedPnlUsd)}
                          </td>
                          <td
                            className="px-3 py-2.5 text-right font-mono text-text-secondary tnum"
                            title={`claimed ${formatUsd(p.claimed_fees_usd ?? 0)} + unclaimed ${formatUsd(p.unclaimed_fees_usd ?? 0)}`}
                          >
                            {formatUsd(feesUsd)}
                          </td>
                          <td className={`px-3 py-2.5 text-right font-mono tnum ${pnlColorClass(net)}`}>
                            {formatPnlUsd(net)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-text-secondary tnum">
                            {formatDuration(derivedAge)}
                          </td>
                        </>
                      );
                    })()}
                    <td className="px-3 py-2.5">{rowStatus(p)}</td>
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <PositionActions p={p} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={11} className="p-0">
                        <OpenPositionDetail p={p} />
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
      <div className="grid grid-cols-1 gap-4 lg:hidden sm:grid-cols-2">
        {positions.map((p) => (
          <PositionCard key={p.position} p={p} actions={<PositionActions p={p} />} />
        ))}
      </div>
    </div>
  );
}

function HistorySection() {
  const lessonsQ = useFile<LessonsFile>("lessons");
  const decisionsQ = useFile<DecisionLogFile>("decision-log");

  if (lessonsQ.isLoading) return <SkeletonRows rows={4} />;
  if (lessonsQ.isError)
    return <ErrorState message="Failed to load position history." onRetry={() => lessonsQ.refetch()} />;

  return (
    <PositionHistory
      performance={lessonsQ.data?.performance}
      decisions={decisionsQ.data?.decisions}
    />
  );
}

export default function PositionsPage() {
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-text-tertiary">Open positions</h2>
        <OpenPositions />
      </section>
      <section>
        <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-text-tertiary">History</h2>
        <HistorySection />
      </section>
    </div>
  );
}
