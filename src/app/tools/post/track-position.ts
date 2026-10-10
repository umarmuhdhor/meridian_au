import type { PostHook } from "../types.js";
import type { DeployResult } from "../../../domain/schemas/chain.js";
import type { TrackedPosition } from "../../../domain/schemas/position.js";
import type { KlineTimeframe, TechnicalsSummary } from "../../../domain/schemas/kline.js";
import { computeTechnicals } from "../../../domain/format/technicals.js";

const ENTRY_TECHNICALS_TIMEFRAMES: readonly KlineTimeframe[] = ["15m", "1h"] as const;
const ENTRY_TECHNICALS_LIMIT = 100;
const ENTRY_TECHNICALS_TIMEOUT_MS = 3_500;

/**
 * Post-hook: persist a freshly deployed position to the position-repo (state.json)
 * so it's fully tracked. Without this the position is still visible via
 * getMyPositions (on-chain) and stop-loss / take-profit / out-of-range still fire
 * off the live snapshot — but trailing-TP (needs the stored peak) and the
 * age/low-yield rule (needs deployed_at + initial_fee_tvl_24h) are degraded.
 * Fires only on a successful deploy; failures are swallowed by the executor.
 */
export function trackDeployedPosition(): PostHook<
  {
    pool_address: string;
    pool_name?: string | undefined;
    strategy: "spot" | "curve" | "bid_ask";
    bin_step?: number | undefined;
    volatility?: number | undefined;
    fee_tvl_ratio?: number | undefined;
    organic_score?: number | undefined;
    mcap?: number | undefined;
    tvl?: number | undefined;
    holders?: number | undefined;
    smart_wallets_present?: boolean | undefined;
    reason?: string | undefined;
    lessons_applied?: string[] | undefined;
  },
  DeployResult
> {
  return async (args, result, ctx) => {
    if (!result.success || !result.position_address) return;
    const now = ctx.clock.now().toISOString();
    // Prefer SOL price × amount as a cheap USD estimate — better than a null
    // seed and doesn't require an extra chain hop. Falls back to null if the
    // wallet balance snapshot fails (RPC hiccup, tests). The management cycle
    // overwrites this with the live total_value_usd on next refresh.
    let initialValueUsd: number | null = null;
    try {
      const wallet = await ctx.chain.getWalletBalance();
      if (wallet?.sol_price != null && result.amount_sol != null) {
        initialValueUsd = Math.round(result.amount_sol * wallet.sol_price * 100) / 100;
      }
    } catch {
      // non-fatal
    }

    // Capture entry technicals so post-mortems can compare entry-vs-exit chart
    // shape ("was every loser entered at at_local_top=YES?"). Fail-open, per
    // timeframe — timeout drops that row but doesn't gate the deploy tracking.
    let entryTechnicals: TechnicalsSummary[] | null = null;
    try {
      const timeout = <T,>(p: Promise<T>): Promise<T | null> =>
        Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), ENTRY_TECHNICALS_TIMEOUT_MS))]);
      const rows = await Promise.all(
        ENTRY_TECHNICALS_TIMEFRAMES.map(async (tf) => {
          const candles = await timeout(
            ctx.market.kline.getKline(result.pool_address ?? args.pool_address, tf, {
              limit: ENTRY_TECHNICALS_LIMIT,
            }),
          ).catch(() => null);
          return computeTechnicals(candles ?? [], tf);
        }),
      );
      // Keep only rows with actual data — an empty candles array yields all-nulls,
      // which is noise. Threshold: at least last_close resolved.
      const useful = rows.filter((r) => r.last_close != null);
      entryTechnicals = useful.length ? useful : null;
    } catch {
      // non-fatal
    }

    const pos: TrackedPosition = {
      position: result.position_address,
      pool: result.pool_address ?? args.pool_address,
      pool_name: args.pool_name ?? null,
      strategy: args.strategy,
      bin_range: { lower_bin: result.lower_bin, upper_bin: result.upper_bin },
      amount_sol: result.amount_sol,
      amount_x: 0, // single-side SOL deploys only
      active_bin_at_deploy: result.active_bin,
      bin_step: args.bin_step ?? result.bin_step ?? null,
      volatility: args.volatility ?? null,
      fee_tvl_ratio: args.fee_tvl_ratio ?? null,
      initial_fee_tvl_24h: args.fee_tvl_ratio ?? null,
      organic_score: args.organic_score ?? null,
      initial_value_usd: initialValueUsd,
      entry_mcap: args.mcap ?? null,
      entry_tvl: args.tvl ?? null,
      holders_at_entry: args.holders ?? null,
      smart_wallets_present: args.smart_wallets_present ?? null,
      entry_technicals: entryTechnicals,
      entry_reason: args.reason?.trim() || ctx.deployMeta?.rationale?.trim() || null,
      lessons_applied: args.lessons_applied?.length ? args.lessons_applied : null,
      deployed_at: now,
      out_of_range_since: null,
      last_claim_at: null,
      total_fees_claimed_usd: 0,
      rebalance_count: 0,
      closed: false,
      closed_at: null,
      notes: [],
      peak_pnl_pct: 0,
      trailing_active: false,
    };
    await ctx.repos.positions.upsert(pos);
    ctx.logger.info("track-position", `tracked new position ${result.position_address.slice(0, 8)}`, {
      pool: pos.pool.slice(0, 8),
      strategy: pos.strategy,
      entry_mcap: pos.entry_mcap,
      holders_at_entry: pos.holders_at_entry,
    });
  };
}
