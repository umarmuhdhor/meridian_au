import type { CloseResult, OnChainPosition } from "../schemas/chain.js";

/**
 * What the tracked record (state.json) knows about a position that the live
 * snapshot may not: the chain client leaves `age_minutes` and `amount_sol` null,
 * which rendered the close card as `deposit: n/a  held: n/a`.
 */
export interface TrackedCloseContext {
  peak_pnl_pct?: number | null;
  amount_sol?: number | null;
  /** Precomputed by the caller (needs a clock) from `deployed_at`. */
  age_minutes?: number | null;
  pool_name?: string | null;
  initial_value_usd?: number | null;
}

/**
 * Real on-chain close returns null pnl/value/fees — those roll up from
 * enrichment layers. Merge the pre-close snapshot data so notify/log
 * consumers see actual pnl %, fees, value, pair, and age instead of `?%`
 * and `$0`. The tracked record fills what the snapshot lacks (deposit, age).
 * With neither, the raw result flows through unchanged.
 */
export function enrichCloseResult(
  result: CloseResult,
  snapshot: OnChainPosition | undefined,
  tracked?: TrackedCloseContext | null,
): CloseResult {
  const t = tracked ?? {};
  const fromTracked: Partial<CloseResult> = {
    pair: result.pair ?? t.pool_name ?? null,
    amount_sol_initial: result.amount_sol_initial ?? t.amount_sol ?? null,
    age_minutes: result.age_minutes ?? t.age_minutes ?? null,
    peak_pnl_pct: t.peak_pnl_pct ?? null,
    initial_value_usd: result.initial_value_usd ?? t.initial_value_usd ?? null,
  };
  if (!snapshot) return tracked ? { ...result, ...fromTracked } : result;
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
    initial_value_usd:
      result.initial_value_usd ?? snapshot.deposit_usd ?? fromTracked.initial_value_usd ?? null,
    pair: snapshot.pair ?? fromTracked.pair ?? null,
    amount_sol_initial: snapshot.amount_sol ?? fromTracked.amount_sol_initial ?? null,
    age_minutes: snapshot.age_minutes ?? fromTracked.age_minutes ?? null,
    peak_pnl_pct: fromTracked.peak_pnl_pct ?? null,
  };
}
