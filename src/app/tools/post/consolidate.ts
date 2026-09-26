import type { PostHook } from "../types.js";
import type { CloseResult } from "../../../domain/schemas/chain.js";
import { consolidateBaseToSol } from "../../management/consolidate.js";

/**
 * After a successful `close_position`, sell the withdrawn base token back to SOL.
 * Covers every close: management, follow, pnl-poller and Telegram all close through the
 * tool (`closeViaTool`), as does the dashboard /tool route.
 *
 * Post-hook failures are swallowed by the executor — and the helper never throws — so a
 * failed consolidation can never break a close.
 */
export const consolidateCloseHook: PostHook<unknown, CloseResult> = async (_args, result, ctx) => {
  if (!result.success) return;
  await consolidateBaseToSol(
    {
      chain: ctx.chain,
      swap: ctx.swap,
      notifier: ctx.notifier,
      logger: ctx.logger,
      slippageBps: ctx.config.management.autoSwapSlippageBps,
      minUsd: ctx.config.management.autoSwapMinUsd,
      retries: ctx.config.management.consolidateRetries,
      retryDelayMs: ctx.config.management.consolidateRetryDelayMs,
    },
    result.base_mint,
  );
};
