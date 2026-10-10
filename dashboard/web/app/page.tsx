"use client";

import { ChartLineUp, GitBranch } from "@phosphor-icons/react";
import { usePositions, useSummary, useFile } from "@/lib/hooks";
import { useDaemonStatus } from "@/components/DaemonStatus";
import { StatCard } from "@/components/StatCard";
import { PositionCard } from "@/components/PositionCard";
import { DecisionTimeline } from "@/components/DecisionTimeline";
import { SkeletonCards, SkeletonRows, EmptyState, ErrorState } from "@/components/states";
import { pnlColorClass } from "@/lib/pnl-color";
import { formatPnlUsd, formatPnlPct, formatSol, formatPct } from "@/lib/format";
import { openPositionPnl } from "@/lib/position-pnl";
import type { LessonsFile, DecisionLogFile, Position } from "@/lib/types";

function winRate(perf: LessonsFile["performance"]): { rate: number | null; n: number } {
  if (!perf || perf.length === 0) return { rate: null, n: 0 };
  const wins = perf.filter((p) => (p.pnl_pct ?? 0) > 0).length;
  return { rate: (wins / perf.length) * 100, n: perf.length };
}

export default function OverviewPage() {
  const positionsQ = usePositions();
  const summaryQ = useSummary();
  const lessonsQ = useFile<LessonsFile>("lessons");
  const decisionsQ = useFile<DecisionLogFile>("decision-log");
  const daemon = useDaemonStatus();

  const positions: Position[] = positionsQ.data?.positions ?? [];
  const sol = summaryQ.data?.balance?.sol;
  const netUsd = positions.reduce((s, p) => s + (openPositionPnl(p).netUsd ?? 0), 0);
  const avgPct = positions.length ? positions.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / positions.length : 0;
  const wr = winRate(lessonsQ.data?.performance);

  const topPositions = [...positions].sort((a, b) => Math.abs(b.total_value_usd ?? 0) - Math.abs(a.total_value_usd ?? 0)).slice(0, 3);
  // Newest-first storage → take the first 5. The old `.slice(-5).reverse()` took
  // the OLDEST 5, so "Recent decisions" showed day-old entries.
  const recentDecisions = (decisionsQ.data?.decisions ?? []).slice(0, 5);

  const kpiLoading = positionsQ.isLoading || summaryQ.isLoading;

  return (
    <div className="flex flex-col gap-6">
      {/* KPI row */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-text-primary">Portfolio</h2>
          <span className="text-[12px] text-text-tertiary">
            {daemon.state === "online" ? "Daemon live" : daemon.state === "degraded" ? "Daemon slow" : "Daemon offline"}
          </span>
        </div>
        {kpiLoading ? (
          <SkeletonCards cards={4} />
        ) : positionsQ.isError ? (
          <ErrorState message="Failed to load portfolio." onRetry={() => positionsQ.refetch()} />
        ) : (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Open positions" value={<span className="text-text-primary">{positions.length}</span>} sub={`max tracked by agent`} />
            <StatCard
              label="Net PnL"
              value={<span className={pnlColorClass(netUsd)}>{formatPnlUsd(netUsd)}</span>}
              sub={
                <span className={pnlColorClass(avgPct)}>
                  {formatPnlPct(avgPct)} · {positions.length} positions
                </span>
              }
              trend={netUsd > 0 ? "up" : netUsd < 0 ? "down" : null}
            />
            <StatCard
              label="Win rate"
              value={<span className="text-text-primary">{wr.rate == null ? "-" : formatPct(wr.rate, 1)}</span>}
              sub={wr.n ? `${wr.n} closed trades` : "no history yet"}
            />
            <StatCard label="Wallet SOL" value={<span className="text-text-primary">{formatSol(sol)}</span>} sub={summaryQ.data?.balance?.error ? "balance unavailable" : "available"} />
          </div>
        )}
      </section>

      {/* Top positions */}
      <section>
        <h2 className="mb-3 text-[15px] font-semibold text-text-primary">Top positions</h2>
        {positionsQ.isLoading ? (
          <SkeletonRows rows={3} />
        ) : positionsQ.isError ? (
          <ErrorState message="Failed to load positions." onRetry={() => positionsQ.refetch()} />
        ) : topPositions.length === 0 ? (
          <EmptyState icon={ChartLineUp} title="No open positions." hint="Run screening from the Screen page to deploy one." />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {topPositions.map((p) => (
              <PositionCard key={p.position} p={p} />
            ))}
          </div>
        )}
      </section>

      {/* Recent decisions */}
      <section>
        <h2 className="mb-3 text-[15px] font-semibold text-text-primary">Recent decisions</h2>
        {decisionsQ.isLoading ? (
          <SkeletonRows rows={4} />
        ) : decisionsQ.isError ? (
          <ErrorState message="Failed to load decisions." onRetry={() => decisionsQ.refetch()} />
        ) : recentDecisions.length === 0 ? (
          <EmptyState icon={GitBranch} title="No decisions logged yet." hint="The agent records deploy, close, skip and no-deploy events here." />
        ) : (
          <DecisionTimeline decisions={recentDecisions} showFilters={false} />
        )}
      </section>
    </div>
  );
}
