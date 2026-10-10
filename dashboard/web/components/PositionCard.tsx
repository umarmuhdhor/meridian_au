import { ArrowSquareOut } from "@phosphor-icons/react";
import { StatusBadge } from "./StatusBadge";
import { pnlColorClass } from "@/lib/pnl-color";
import { formatPnlPct, formatPnlUsd, formatUsd, formatDuration, binRange } from "@/lib/format";
import { meteoraPoolUrl } from "@/lib/meteora";
import { openPositionPnl } from "@/lib/position-pnl";
import type { Position } from "@/lib/types";
import { cn } from "@/lib/cn";

function statusOf(p: Position): { status: "in_range" | "out_of_range"; detail?: string } {
  if (p.in_range === false) {
    const m = p.minutes_out_of_range;
    return { status: "out_of_range", detail: m != null ? formatDuration(m) : undefined };
  }
  return { status: "in_range" };
}

// Compact position card for the Overview top-3 (Design §11.3).
export function PositionCard({ p, actions }: { p: Position; actions?: React.ReactNode }) {
  const { status, detail } = statusOf(p);
  const name = p.pool_name || p.pair || "Position";
  // Net of fees, matching Meteora and the pnl_pct shown above it.
  const { netUsd: net, feesUsd } = openPositionPnl(p);

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-surface-1 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {p.pool ? (
            <a
              href={meteoraPoolUrl(p.pool)}
              target="_blank"
              rel="noopener noreferrer"
              title="Open pool on Meteora"
              className="group inline-flex max-w-full items-center gap-1 text-[15px] font-semibold text-text-primary hover:underline"
            >
              <span className="truncate">{name}</span>
              <ArrowSquareOut size={13} className="shrink-0 text-text-tertiary group-hover:text-text-secondary" />
            </a>
          ) : (
            <div className="truncate text-[15px] font-semibold text-text-primary">{name}</div>
          )}
          <div className="text-[12px] text-text-tertiary">{p.strategy || "-"}</div>
        </div>
        <StatusBadge status={status} detail={detail} />
      </div>

      <div className="flex items-end justify-between">
        <div>
          <div className={cn("font-mono text-[20px] font-medium leading-7 tnum", pnlColorClass(p.pnl_pct))}>
            {formatPnlPct(p.pnl_pct)}
          </div>
          <div className="text-[12px] text-text-secondary tnum">
            <span className={pnlColorClass(net)}>{formatPnlUsd(net)}</span>
            {p.peak_pnl_pct != null && (
              <span className="ml-2 text-text-tertiary">peak {formatPnlPct(p.peak_pnl_pct)}</span>
            )}
          </div>
        </div>
        <div className="text-right text-[12px] text-text-tertiary">
          <div className="font-mono tnum">{binRange(p.lower_bin ?? null, p.upper_bin ?? null)}</div>
          <div className="tnum">fee {formatUsd(feesUsd)}</div>
          <div className="tnum">{formatDuration(p.age_minutes)}</div>
        </div>
      </div>

      {p.instruction && (
        <div className="rounded-[var(--radius-md)] border border-border px-2 py-1 text-[12px] text-text-secondary" style={{ backgroundColor: "var(--accent-tint)" }}>
          Note: {p.instruction}
        </div>
      )}

      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
