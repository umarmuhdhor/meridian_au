import type { CloseResult, OnChainPosition } from "../schemas/chain.js";

/**
 * Real on-chain close returns null pnl/value/fees — those roll up from
 * enrichment layers. Merge the pre-close snapshot data so notify/log
 * consumers see actual pnl %, fees, value, pair, and age instead of `?%`
 * and `$0`. Snapshot-less callers (e.g. unknown position) pass undefined
 * and the raw result flows through unchanged.
 */
export function enrichCloseResult(
  result: CloseResult,
  snapshot: OnChainPosition | undefined,
  peakPnlPct?: number | null,
): CloseResult {
  if (!snapshot) return result;
  return {
    ...result,
    base_mint: result.base_mint ?? snapshot.base_mint,
    final_pnl_pct: result.final_pnl_pct ?? snapshot.pnl_pct,
    final_value_usd: result.final_value_usd ?? snapshot.total_value_usd ?? null,
    // Lifetime fees = already claimed + still unclaimed. Reading only the unclaimed half
    // dropped every fee the management cycle had claimed before the close.
    fees_earned_usd:
      result.fees_earned_usd ||
      (snapshot.unclaimed_fees_usd ?? 0) + (snapshot.claimed_fees_usd ?? 0),
    initial_value_usd: result.initial_value_usd ?? snapshot.deposit_usd ?? null,
    pair: snapshot.pair,
    amount_sol_initial: snapshot.amount_sol ?? null,
    age_minutes: snapshot.age_minutes ?? null,
    peak_pnl_pct: peakPnlPct ?? null,
  };
}
