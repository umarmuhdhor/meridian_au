import type { PostHook } from "../types.js";
import type { CloseResult } from "../../../domain/schemas/chain.js";
import type { PerformanceRecord } from "../../../domain/schemas/lesson.js";
import type { KlineTimeframe, TechnicalsSummary } from "../../../domain/schemas/kline.js";
import { computeTechnicals } from "../../../domain/format/technicals.js";
import { estimateClosePnl } from "../../../domain/format/close-pnl.js";

const EXIT_TECHNICALS_TIMEFRAMES: readonly KlineTimeframe[] = ["15m", "1h"] as const;
const EXIT_TECHNICALS_LIMIT = 100;
const EXIT_TECHNICALS_TIMEOUT_MS = 3_500;

/**
 * Append a PerformanceRecord to lessons.json after a successful close.
 * Without this the morning briefing (BriefingCounts.net_pnl_usd_24h /
 * fees_usd_24h / win_rate_pct_24h) is permanently empty — nothing else
 * calls `repos.lessons.appendPerformance`.
 *
 * Copies every tracked-side context field (strategy, bin_range, bin_step,
 * volatility, fee_tvl_ratio, organic_score, entry_mcap, holders_at_entry,
 * smart_wallets_present) into the record so the Positions history row can
 * render without needing a JOIN against state.json (which prunes closed
 * positions on cleanup). Fetches exit_mcap via the TokenInfo port —
 * best-effort, null if the lookup fails.
 *
 * Non-fatal: hook errors are swallowed by executeTool.
 */
export const recordPerformanceHook: PostHook<
  { position_address: string; reason: string },
  CloseResult
> = async (args, result, ctx) => {
  if (!result.success) return;

  const tracked = await ctx.repos.positions.get(args.position_address);

  let solPrice: number | null = null;
  try {
    const wallet = await ctx.chain.getWalletBalance();
    solPrice = wallet.sol_price;
  } catch {
    // Non-fatal — pnl_usd will fall back to 0 rather than crash the hook.
  }

  const amountSol = result.amount_sol_initial ?? tracked?.amount_sol ?? null;
  // Meteora's recorded deposit first — the same basis `final_value_usd` and the fees
  // are measured against. The tracked value is our own deploy-time guess.
  const initialValueUsd =
    result.initial_value_usd ??
    tracked?.initial_value_usd ??
    (amountSol != null && solPrice != null ? amountSol * solPrice : null);
  // An estimate; the management cycle replaces it with Meteora's settled totals once
  // the close is indexed (finalize-performance.ts).
  const est = estimateClosePnl({
    initialValueUsd,
    finalValueUsd: result.final_value_usd ?? null,
    feesUsd: result.fees_earned_usd,
    fallbackPnlPct: result.final_pnl_pct,
  });

  const now = ctx.clock.now();
  const deployedAtMs = tracked?.deployed_at ? Date.parse(tracked.deployed_at) : NaN;
  const minutesHeld = Number.isFinite(deployedAtMs)
    ? Math.max(0, Math.round((now.getTime() - deployedAtMs) / 60_000))
    : undefined;

  // Exit technicals snapshot — same pattern as entry, fail-open. Feeds
  // entry-vs-exit chart-shape retrospectives ("did we exit at a bounce?").
  let exitTechnicals: TechnicalsSummary[] | null = null;
  if (result.pool_address) {
    try {
      const timeout = <T,>(p: Promise<T>): Promise<T | null> =>
        Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), EXIT_TECHNICALS_TIMEOUT_MS))]);
      const rows = await Promise.all(
        EXIT_TECHNICALS_TIMEFRAMES.map(async (tf) => {
          const candles = await timeout(
            ctx.market.kline.getKline(result.pool_address!, tf, { limit: EXIT_TECHNICALS_LIMIT }),
          ).catch(() => null);
          return computeTechnicals(candles ?? [], tf);
        }),
      );
      const useful = rows.filter((r) => r.last_close != null);
      exitTechnicals = useful.length ? useful : null;
    } catch {
      // non-fatal
    }
  }

  // Exit-mcap lookup — best-effort. TokenInfo tends to be cached (~1 min TTL)
  // so this rarely hits the network, and a failure here should not gate the
  // write.
  let exitMcap: number | null = null;
  const baseMint = result.base_mint ?? null;
  if (baseMint) {
    try {
      const info = await ctx.market.tokenInfo.getInfo(baseMint);
      exitMcap = info.mcap ?? null;
    } catch {
      // non-fatal
    }
  }

  const binRange =
    tracked?.bin_range?.lower_bin != null && tracked?.bin_range?.upper_bin != null
      ? { min: tracked.bin_range.lower_bin, max: tracked.bin_range.upper_bin }
      : undefined;

  const perf: PerformanceRecord = {
    position: args.position_address,
    pool: result.pool_address,
    pool_name: tracked?.pool_name ?? result.pair ?? null,
    pnl_pct: est.pnl_pct,
    pnl_usd: est.pnl_usd,
    fees_earned_usd: est.fees_earned_usd,
    ...(est.initial_value_usd != null ? { initial_value_usd: est.initial_value_usd } : {}),
    ...(est.final_value_usd != null ? { final_value_usd: est.final_value_usd } : {}),
    pnl_source: "estimate",
    ...(minutesHeld !== undefined ? { minutes_held: minutesHeld } : {}),
    close_reason: args.reason,
    ...(amountSol != null ? { amount_sol: amountSol } : {}),
    // ── copied from TrackedPosition so the row renders standalone ──
    ...(tracked?.strategy ? { strategy: tracked.strategy } : {}),
    ...(binRange ? { bin_range: binRange } : {}),
    ...(tracked?.bin_step != null ? { bin_step: tracked.bin_step } : {}),
    ...(tracked?.volatility != null ? { volatility: tracked.volatility } : {}),
    ...(tracked?.fee_tvl_ratio != null ? { fee_tvl_ratio: tracked.fee_tvl_ratio } : {}),
    ...(tracked?.organic_score != null ? { organic_score: tracked.organic_score } : {}),
    ...(tracked?.entry_mcap != null ? { entry_mcap: tracked.entry_mcap } : {}),
    ...(exitMcap != null ? { exit_mcap: exitMcap } : {}),
    ...(baseMint ? { base_mint: baseMint } : {}),
    ...(tracked?.entry_technicals ? { entry_technicals: tracked.entry_technicals } : {}),
    ...(exitTechnicals ? { exit_technicals: exitTechnicals } : {}),
    ...(tracked?.holders_at_entry != null ? { holders_at_entry: tracked.holders_at_entry } : {}),
    ...(tracked?.smart_wallets_present != null
      ? { smart_wallets_present: tracked.smart_wallets_present }
      : {}),
    closed_at: now.toISOString(),
    recorded_at: now.toISOString(),
  };

  try {
    await ctx.repos.lessons.appendPerformance(perf);
    ctx.logger.info("perf", `recorded close ${args.position_address.slice(0, 8)}`, {
      pnl_pct: perf.pnl_pct,
      pnl_usd: perf.pnl_usd,
      fees_usd: perf.fees_earned_usd,
      reason: args.reason,
      strategy: perf.strategy,
      entry_mcap: perf.entry_mcap,
      exit_mcap: perf.exit_mcap,
    });
  } catch (err) {
    ctx.logger.warn("perf", "appendPerformance failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
