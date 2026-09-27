import type { ClosedPositionPnl } from "../schemas/chain.js";
import type { PerformanceRecord } from "../schemas/lesson.js";

/**
 * PnL bookkeeping for a closed position, in the shape the performance record stores.
 *
 * Field semantics (the dashboard's history table depends on them):
 *   - `pnl_usd`         = exit value − entry value. Price movement only, fees EXCLUDED.
 *   - `fees_earned_usd` = every fee the position earned: claimed along the way + at close.
 *   - net PnL           = `pnl_usd + fees_earned_usd` (computed by readers, not stored).
 *   - `pnl_pct`         = net PnL ÷ entry value — the figure Meteora labels "PnL %".
 *
 * Before 2026-09-27 the close path recorded fees = unclaimed-at-close only, so any fee
 * the management cycle had already claimed vanished from the record, while `pnl_pct`
 * (datapi, fees included) and `pnl_usd` (fees excluded) disagreed in sign.
 */
export interface ClosePnl {
  pnl_pct: number;
  pnl_usd: number;
  fees_earned_usd: number;
  initial_value_usd: number | null;
  final_value_usd: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Best estimate at the moment of close, from the last open-position snapshot.
 * `fallbackPnlPct` (datapi's reported %) is used only when the USD figures needed to
 * derive a consistent net % are missing.
 */
export function estimateClosePnl(input: {
  initialValueUsd: number | null;
  finalValueUsd: number | null;
  feesUsd: number;
  fallbackPnlPct: number | null;
}): ClosePnl {
  const { initialValueUsd: initial, finalValueUsd: final, feesUsd: fees } = input;
  let pnlUsd = 0;
  let pnlPct = input.fallbackPnlPct ?? 0;
  if (final != null && initial != null) {
    pnlUsd = final - initial;
    if (initial > 0) pnlPct = ((pnlUsd + fees) / initial) * 100;
  } else if (initial != null) {
    // No exit value: back the price-only PnL out of the net % we do have.
    pnlUsd = (initial * pnlPct) / 100 - fees;
  }
  return {
    pnl_pct: pnlPct,
    pnl_usd: round2(pnlUsd),
    fees_earned_usd: fees,
    initial_value_usd: initial,
    final_value_usd: final,
  };
}

/**
 * The settled figures Meteora reports for a closed position. Returns `null` when the
 * totals do not look settled yet — a close whose withdrawal has not been indexed reads
 * as a −100% loss, and recording that would be worse than keeping the estimate.
 */
export function settledClosePnl(closed: ClosedPositionPnl): ClosePnl | null {
  if (!(closed.deposits_usd > 0) || !(closed.withdrawals_usd > 0)) return null;
  const pnlUsd = closed.withdrawals_usd - closed.deposits_usd;
  return {
    pnl_pct: ((pnlUsd + closed.fees_usd) / closed.deposits_usd) * 100,
    pnl_usd: round2(pnlUsd),
    fees_earned_usd: closed.fees_usd,
    initial_value_usd: closed.deposits_usd,
    final_value_usd: closed.withdrawals_usd,
  };
}

/** True once a record carries Meteora's settled numbers — no further reconcile needed. */
export function isPnlSettled(perf: PerformanceRecord): boolean {
  return perf.pnl_source === "meteora_closed";
}
