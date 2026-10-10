"use client";

import { TrendUp } from "@phosphor-icons/react";
import { useFile } from "@/lib/hooks";
import { SignalWeightChart } from "@/components/SignalWeightChart";
import { PerformanceChart } from "@/components/PerformanceChart";
import { PoolTrendChart } from "@/components/PoolTrendChart";
import { LearningLoop } from "@/components/LearningLoop";
import { SkeletonRows, ErrorState } from "@/components/states";
import { relativeTime } from "@/lib/format";
import type { SignalWeightsFile, LessonsFile, PoolMemoryFile } from "@/lib/types";

type LearningLoopProps = React.ComponentProps<typeof LearningLoop>;

function Panel({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-border bg-surface-1 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-text-primary">{title}</h2>
        {meta ? <span className="text-[12px] text-text-tertiary">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

export default function LearningPage() {
  const weightsQ = useFile<SignalWeightsFile>("signal-weights");
  const lessonsQ = useFile<LessonsFile>("lessons");
  const poolQ = useFile<PoolMemoryFile>("pool-memory");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <TrendUp size={20} className="text-accent-bright" />
        <div>
          <h1 className="text-[15px] font-semibold text-text-primary">Learning & Darwin</h1>
          <p className="text-[12px] text-text-tertiary">Signal weighting, closed-trade performance, and per-pool trend.</p>
        </div>
      </div>

      <Panel
        title="Learning loop"
        meta={lessonsQ.data?.lessons?.length ? `${lessonsQ.data.lessons.length} lessons` : undefined}
      >
        {lessonsQ.isLoading ? (
          <SkeletonRows rows={5} />
        ) : lessonsQ.isError ? (
          <ErrorState message="Failed to load lessons." onRetry={() => lessonsQ.refetch()} />
        ) : (
          <LearningLoop
            lessons={lessonsQ.data?.lessons as unknown as LearningLoopProps["lessons"]}
            performance={lessonsQ.data?.performance as unknown as LearningLoopProps["performance"]}
          />
        )}
      </Panel>

      <Panel
        title="Signal weights"
        meta={
          weightsQ.data?.last_recalc
            ? `recalc ${weightsQ.data.recalc_count ?? 0}x · ${relativeTime(weightsQ.data.last_recalc)}`
            : undefined
        }
      >
        {weightsQ.isLoading ? (
          <SkeletonRows rows={5} />
        ) : weightsQ.isError ? (
          <ErrorState message="Failed to load signal weights." onRetry={() => weightsQ.refetch()} />
        ) : (
          <SignalWeightChart weights={weightsQ.data?.weights} />
        )}
      </Panel>

      <Panel title="Performance" meta={lessonsQ.data?.performance?.length ? `${lessonsQ.data.performance.length} closed` : undefined}>
        {lessonsQ.isLoading ? (
          <SkeletonRows rows={5} />
        ) : lessonsQ.isError ? (
          <ErrorState message="Failed to load performance." onRetry={() => lessonsQ.refetch()} />
        ) : (
          <PerformanceChart performance={lessonsQ.data?.performance} />
        )}
      </Panel>

      <Panel title="Pool-memory trend">
        {poolQ.isLoading ? (
          <SkeletonRows rows={5} />
        ) : poolQ.isError ? (
          <ErrorState message="Failed to load pool memory." onRetry={() => poolQ.refetch()} />
        ) : (
          <PoolTrendChart poolMemory={poolQ.data} />
        )}
      </Panel>
    </div>
  );
}
