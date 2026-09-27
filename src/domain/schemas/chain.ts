import { z } from "zod";

/** Active bin snapshot from a Meteora DLMM pool. */
export const ActiveBinSchema = z.object({
  binId: z.number().int(),
  price: z.number(),
  pricePerLamport: z.string(),
});
export type ActiveBin = z.infer<typeof ActiveBinSchema>;

/** Live position snapshot from the chain, enriched with tracked metadata. */
export const OnChainPositionSchema = z.object({
  position: z.string(),
  pool: z.string(),
  pair: z.string(),
  base_mint: z.string().nullable(),
  lower_bin: z.number().int(),
  upper_bin: z.number().int(),
  active_bin: z.number().int(),
  in_range: z.boolean(),
  unclaimed_fees_usd: z.number(),
  pnl_pct: z.number().nullable(),
  pnl_pct_suspicious: z.boolean().default(false),
  total_value_usd: z.number().nullable().optional(),
  fee_per_tvl_24h: z.number().nullable().optional(),
  age_minutes: z.number().int().nonnegative().nullable().optional(),
  minutes_out_of_range: z.number().int().nonnegative().optional(),
  strategy: z.enum(["spot", "curve", "bid_ask"]).optional(),
  bin_step: z.number().int().optional(),
  amount_sol: z.number().optional(),
  deployed_at: z.string().optional(),
  /** Sum of all deposits into this position, per Meteora datapi. Populated when
   *  the datapi enricher is wired (real chain client). Recovers `initial_value_usd`
   *  / `amount_sol` for externally-opened / pre-hook positions during reconcile. */
  deposit_sol: z.number().nullable().optional(),
  deposit_usd: z.number().nullable().optional(),
  /** Fees already claimed out of this position (datapi `allTimeFees`), USD. Distinct
   *  from `unclaimed_fees_usd`: a position's lifetime fee take is the SUM of the two,
   *  and a close that only reads the unclaimed half under-reports every position the
   *  management cycle claimed from along the way. */
  claimed_fees_usd: z.number().nullable().optional(),
});
export type OnChainPosition = z.infer<typeof OnChainPositionSchema>;

export const PositionsSnapshotSchema = z.object({
  total_positions: z.number().int().nonnegative(),
  positions: z.array(OnChainPositionSchema),
  wallet: z.string().optional(),
  fetched_at: z.string(),
});
export type PositionsSnapshot = z.infer<typeof PositionsSnapshotSchema>;

/** Deploy call — what the chain client receives. */
export const DeployArgsSchema = z.object({
  pool_address: z.string(),
  amount_sol: z.number().positive(),
  strategy: z.enum(["spot", "curve", "bid_ask"]),
  bins_below: z.number().int().min(1),
  bins_above: z.number().int().nonnegative().default(0),
  pool_name: z.string().optional(),
  bin_step: z.number().int().optional(),
  volatility: z.number().optional(),
  fee_tvl_ratio: z.number().optional(),
  organic_score: z.number().optional(),
  /** Base-token market cap at deploy time (USD) — snapshotted for post-mortem. */
  mcap: z.number().optional(),
  /** Base-token holder count at deploy time. */
  holders: z.number().int().nonnegative().optional(),
  /** Smart-wallet flag at deploy time. */
  smart_wallets_present: z.boolean().optional(),
  /**
   * Waives the 35-bin safety floor in planDeploy. Set only by follow_deploy_position,
   * which copies a followed wallet's range verbatim.
   */
  allow_tiny_range: z.boolean().optional(),
});
export type DeployArgs = z.infer<typeof DeployArgsSchema>;

export const DeployResultSchema = z.object({
  success: z.boolean(),
  position_address: z.string(),
  pool_address: z.string(),
  strategy: z.enum(["spot", "curve", "bid_ask"]),
  lower_bin: z.number().int(),
  upper_bin: z.number().int(),
  active_bin: z.number().int(),
  amount_sol: z.number(),
  tx: z.string().nullable(),
  dry_run: z.boolean().default(false),
  bin_step: z.number().int().positive().optional(),
  // Enriched from args so the notifier has pool name, base mint, and the
  // pool-quality signals the screener used to pick this pool. All optional
  // because the on-chain deploy path only returns the placement itself.
  pool_name: z.string().nullable().optional(),
  base_mint: z.string().nullable().optional(),
  volatility: z.number().nullable().optional(),
  fee_tvl_ratio: z.number().nullable().optional(),
  organic_score: z.number().nullable().optional(),
  mcap: z.number().nullable().optional(),
  holders: z.number().int().nonnegative().nullable().optional(),
  smart_wallets_present: z.boolean().nullable().optional(),
});
export type DeployResult = z.infer<typeof DeployResultSchema>;

export const ClaimResultSchema = z.object({
  success: z.boolean(),
  position_address: z.string(),
  claimed_usd: z.number().nonnegative(),
  claimed_sol: z.number().nonnegative().optional(),
  tx: z.string().nullable(),
  dry_run: z.boolean().default(false),
});
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

export const CloseResultSchema = z.object({
  success: z.boolean(),
  position_address: z.string(),
  pool_address: z.string(),
  base_mint: z.string().nullable(),
  final_pnl_pct: z.number().nullable(),
  final_value_usd: z.number().nullable(),
  fees_earned_usd: z.number().nonnegative(),
  reason: z.string(),
  tx: z.string().nullable(),
  dry_run: z.boolean().default(false),
  // Enriched from the pre-close snapshot at the call site so the notifier
  // can render a human-useful close message instead of `pnl: ?% / fees: $0`.
  pair: z.string().nullable().optional(),
  amount_sol_initial: z.number().nullable().optional(),
  age_minutes: z.number().int().nonnegative().nullable().optional(),
  peak_pnl_pct: z.number().nullable().optional(),
  /** Deposited value per Meteora datapi, from the pre-close snapshot. */
  initial_value_usd: z.number().nullable().optional(),
});
export type CloseResult = z.infer<typeof CloseResultSchema>;

/**
 * Settled totals for a CLOSED position, per Meteora datapi (`status=closed`) — the same
 * numbers Meteora's "All Closed Position" view shows. All USD. Net PnL is
 * `withdrawals_usd + fees_usd - deposits_usd`.
 */
export const ClosedPositionPnlSchema = z.object({
  position: z.string(),
  deposits_usd: z.number(),
  withdrawals_usd: z.number(),
  fees_usd: z.number().nonnegative(),
});
export type ClosedPositionPnl = z.infer<typeof ClosedPositionPnlSchema>;

/** Wallet SOL balance + USD. */
export const WalletBalanceSchema = z.object({
  sol: z.number().nonnegative(),
  sol_usd: z.number().nonnegative(),
  sol_price: z.number().positive(),
  fetched_at: z.string(),
});
export type WalletBalance = z.infer<typeof WalletBalanceSchema>;

/** One SPL token holding in the wallet (for the dashboard wallet page). */
export const WalletTokenSchema = z.object({
  mint: z.string(),
  symbol: z.string().nullable(),
  balance: z.number().nonnegative(),
  usd: z.number().nonnegative().nullable(),
  /** Raw on-chain amount in base units (integer string, uiAmount × 10^decimals). Needed
   *  to swap the exact holding — `balance` is uiAmount and would under-fund the swap.
   *  A string (not number) so large-supply / low-decimal balances keep full precision.
   *  Optional so existing callers/readers (dashboard wallet page) are unaffected. */
  raw: z.string().optional(),
});
export type WalletToken = z.infer<typeof WalletTokenSchema>;

/** Jupiter swap quote + tx. */
export const SwapArgsSchema = z.object({
  input_mint: z.string(),
  output_mint: z.string(),
  amount_in: z.number().positive(),
  /** Optional RAW base-unit integer string. When present, the adapter uses this (via
   *  BigInt) as the exact swap amount instead of `amount_in`, avoiding number precision
   *  loss for large-supply tokens. Set by the auto-swap consolidation path. */
  amount_in_raw: z.string().regex(/^\d+$/).optional(),
  slippage_bps: z.number().int().min(1).max(10_000).default(100),
});
export type SwapArgs = z.infer<typeof SwapArgsSchema>;

export const SwapResultSchema = z.object({
  success: z.boolean(),
  input_mint: z.string(),
  output_mint: z.string(),
  amount_in: z.number(),
  amount_out: z.number(),
  price_impact_pct: z.number().optional(),
  tx: z.string().nullable(),
  dry_run: z.boolean().default(false),
});
export type SwapResult = z.infer<typeof SwapResultSchema>;
