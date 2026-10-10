import type { Position } from "./types";

export interface OpenPositionPnl {
  /** Current value − entry value. Price movement only, fees EXCLUDED (same as History's "PnL $"). */
  pnlUsd: number | null;
  /** Every fee the position has earned: already claimed + still unclaimed. */
  feesUsd: number;
  /** pnlUsd + feesUsd — the dollar PnL Meteora's UI shows for the position. */
  netUsd: number | null;
}

/**
 * Dollar PnL of an OPEN position, on the same basis as Meteora and as the History table.
 *
 * Computed client-side from the live fields (rather than trusting a server `pnl_usd`)
 * because the SSE `pnl_tick` overlays total value and fees every few seconds but never
 * carries a derived `pnl_usd` — a server figure would go stale after the first tick.
 *
 * Entry = Meteora's recorded deposit when present, else our deploy-time estimate. Fees
 * include the ones the management cycle already claimed: counting only the unclaimed
 * remainder under-reports a position that has been harvested (JEANPHIL: +$0.37 on
 * Meteora, −$4.77 on the dashboard before this).
 */
export function openPositionPnl(p: Position): OpenPositionPnl {
  const feesUsd = (p.claimed_fees_usd ?? 0) + (p.unclaimed_fees_usd ?? 0);
  const entry = p.deposit_usd ?? p.initial_value_usd ?? null;
  let pnlUsd: number | null = null;
  if (p.total_value_usd != null && entry != null) {
    pnlUsd = p.total_value_usd - entry;
  } else if (p.pnl_usd != null) {
    pnlUsd = p.pnl_usd;
  }
  return { pnlUsd, feesUsd, netUsd: pnlUsd != null ? pnlUsd + feesUsd : null };
}
