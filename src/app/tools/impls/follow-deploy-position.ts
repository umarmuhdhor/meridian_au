import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { DeployResultSchema } from "../../../domain/schemas/chain.js";
import { walletBalanceGate } from "../safety/wallet-balance.js";
import { maxPositionsGate } from "../safety/max-positions.js";
import { logDeployDecision } from "../post/log-decision.js";
import { notifyDeployHook } from "../post/notify.js";
import { trackDeployedPosition } from "../post/track-position.js";

const ArgsSchema = z.object({
  pool_address: z.string().min(1),
  amount_sol: z.number().positive(),
  strategy: z.enum(["spot", "curve", "bid_ask"]),
  /**
   * Deliberately unbounded at the top compared to deploy_position's 35..69 — the width
   * is copied from the followed wallet, and the caller (follow cycle) has already
   * clamped it to the configured follow bounds. >69 routes to the wide-range multi-tx
   * path in write-paths.ts exactly as it does for a screener deploy.
   */
  bins_below: z.number().int().min(1).max(400),
  bins_above: z.number().int().nonnegative().default(0),
  pool_name: z.string().optional(),
  base_mint: z.string().nullable().optional(),
  bin_step: z.number().int().optional(),
  /** Waives the 35-bin floor in planDeploy — see follow.minBinsBelow. */
  allow_tiny_range: z.boolean().default(true),
  /** Who we are copying — rendered into the Telegram card and the decision log. */
  source_wallet: z.string().min(1),
  source_label: z.string().default(""),
});

/**
 * Mirror-open for the follow-the-wallet feature.
 *
 * Separate from `deploy_position` on purpose. The screener's tool carries five safety
 * gates because the screener picks pools on its own judgement; this one is executing a
 * decision the user delegated to a wallet they chose, so the discretionary gates are
 * absent BY DESIGN:
 *
 *   dropped  — pool cooldown, base-mint cooldown, token blacklist, deployer blocklist
 *   kept     — wallet balance (cannot spend SOL we do not have)
 *   kept     — max positions (portfolio-level exposure cap the user did not waive)
 *
 * It is also not registered in any role's tool list, so no LLM can reach it. The only
 * caller is the follow cycle.
 */
export const followDeployPositionTool = defineTool({
  name: "follow_deploy_position",
  description:
    "Mirror a followed wallet's DLMM entry. Bypasses cooldown/blacklist/TA screening by design; still gated on wallet balance and max positions. Not LLM-callable.",
  args: ArgsSchema,
  result: DeployResultSchema,
  safety: [walletBalanceGate, maxPositionsGate],
  post: [trackDeployedPosition(), notifyDeployHook, logDeployDecision("FOLLOW")],
  execute: async (args, ctx) => {
    const raw = await ctx.chain.deployPosition({
      pool_address: args.pool_address,
      amount_sol: args.amount_sol,
      strategy: args.strategy,
      bins_below: args.bins_below,
      bins_above: args.bins_above,
      allow_tiny_range: args.allow_tiny_range,
      ...(args.pool_name !== undefined ? { pool_name: args.pool_name } : {}),
      ...(args.bin_step !== undefined ? { bin_step: args.bin_step } : {}),
      smart_wallets_present: true,
    });
    return {
      ...raw,
      pool_name: args.pool_name ?? raw.pool_name ?? null,
      base_mint: args.base_mint ?? raw.base_mint ?? null,
      volatility: null,
      fee_tvl_ratio: null,
      organic_score: null,
      mcap: null,
      holders: null,
      smart_wallets_present: true,
    };
  },
});
