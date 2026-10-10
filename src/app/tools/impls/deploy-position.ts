import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { DeployResultSchema } from "../../../domain/schemas/chain.js";
import { poolCooldownGate } from "../safety/pool-cooldown.js";
import { walletBalanceGate } from "../safety/wallet-balance.js";
import { maxPositionsGate } from "../safety/max-positions.js";
import { tokenBlacklistGate } from "../safety/token-blacklist.js";
import { deployerBlocklistGate } from "../safety/deployer-blocklist.js";
import { logDeployDecision } from "../post/log-decision.js";
import { notifyDeployHook } from "../post/notify.js";
import { trackDeployedPosition } from "../post/track-position.js";

const ArgsSchema = z.object({
  pool_address: z.string().min(1),
  amount_sol: z.number().positive(),
  strategy: z.enum(["spot", "curve", "bid_ask"]),
  bins_below: z.number().int().min(35).max(69),
  bins_above: z.number().int().nonnegative().default(0),
  pool_name: z.string().optional(),
  base_mint: z.string().nullable().optional(),
  bin_step: z.number().int().optional(),
  volatility: z.number().optional(),
  fee_tvl_ratio: z.number().optional(),
  organic_score: z.number().optional(),
  mcap: z.number().optional(),
  holders: z.number().int().nonnegative().optional(),
  smart_wallets_present: z.boolean().optional(),
  /** Why this pool + strategy, in the screener's words. Recorded for the close review. */
  reason: z.string().max(600).optional(),
  /** Ids of the lessons that shaped this deploy. Scored against the outcome after close. */
  lessons_applied: z.array(z.string()).max(30).optional(),
});

/**
 * Full write path — safety chain gates on pool cooldown, base-mint cooldown, wallet balance,
 * max positions, blacklist. Post-hooks fire only on `result.success === true`: notify
 * Telegram + append decision log. Lock: oncePerSession + noRetry (first attempt is the last).
 */
export const deployPositionTool = defineTool({
  name: "deploy_position",
  description:
    "Open a Meteora DLMM position with the given SOL amount, strategy, and bin range. Safety-gated: pool cooldown, base-mint cooldown, wallet balance, max positions, token blacklist. Fires ONCE per agent session — the LLM cannot retry after any attempt.",
  args: ArgsSchema,
  result: DeployResultSchema,
  oncePerSession: true,
  noRetry: true,
  safety: [poolCooldownGate, tokenBlacklistGate, deployerBlocklistGate, walletBalanceGate, maxPositionsGate],
  post: [trackDeployedPosition(), notifyDeployHook, logDeployDecision("SCREENER")],
  execute: async (args, ctx) => {
    const raw = await ctx.chain.deployPosition({
      pool_address: args.pool_address,
      amount_sol: args.amount_sol,
      strategy: args.strategy,
      bins_below: args.bins_below,
      bins_above: args.bins_above,
      ...(args.pool_name !== undefined ? { pool_name: args.pool_name } : {}),
      ...(args.bin_step !== undefined ? { bin_step: args.bin_step } : {}),
      ...(args.volatility !== undefined ? { volatility: args.volatility } : {}),
      ...(args.fee_tvl_ratio !== undefined ? { fee_tvl_ratio: args.fee_tvl_ratio } : {}),
      ...(args.organic_score !== undefined ? { organic_score: args.organic_score } : {}),
    });
    // Preserve the screener's context (pool name, base mint, quality signals)
    // in the result so notify/log consumers can render human-useful output
    // without a second lookup.
    return {
      ...raw,
      pool_name: args.pool_name ?? raw.pool_name ?? null,
      base_mint: args.base_mint ?? raw.base_mint ?? null,
      volatility: args.volatility ?? null,
      fee_tvl_ratio: args.fee_tvl_ratio ?? null,
      organic_score: args.organic_score ?? null,
      mcap: args.mcap ?? null,
      holders: args.holders ?? null,
      smart_wallets_present: args.smart_wallets_present ?? null,
    };
  },
});
