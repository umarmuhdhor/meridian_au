import type { PostHook } from "../types.js";
import type { DeployResult, CloseResult } from "../../../domain/schemas/chain.js";
import type { DecisionActor } from "../../../domain/schemas/decision.js";
import { sanitizeDecisionText } from "../../../domain/schemas/decision.js";
import {
  formatCloseReason,
  formatCloseSummary,
  formatDeployReason,
  formatDeploySummary,
} from "../../../domain/format/decision-strings.js";

function nextId(now: Date): string {
  return `dec_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Post-hook: append a deploy decision after every successful deploy_position call. */
export function logDeployDecision(defaultActor: DecisionActor): PostHook<{
  pool_address: string;
  pool_name?: string | undefined;
  amount_sol: number;
  strategy: string;
  bin_step?: number | undefined;
  reason?: string | undefined;
  lessons_applied?: string[] | undefined;
}, DeployResult> {
  return async (args, result, ctx) => {
    if (!result.success) return;
    // Per-call actor + rationale from the caller (screening cycle / bridge), else the
    // `reason` the LLM passed to deploy_position itself.
    // Falls back to the registered default (SCREENER) only when unset.
    const actor = ctx.deployMeta?.actor ?? defaultActor;
    const callerRationale = ctx.deployMeta?.rationale?.trim() || args.reason?.trim() || null;
    const lessonsApplied = args.lessons_applied?.filter(Boolean) ?? [];
    // Enrich pool_name from the tracked position when the caller (typically Sage
    // via mrd_deploy_position) forgot to include it — trackDeployedPosition runs
    // BEFORE this hook, so state.json already has the record for this position.
    let poolName = args.pool_name ?? null;
    if (!poolName && result.position_address) {
      const tracked = await ctx.repos.positions.get(result.position_address);
      poolName = tracked?.pool_name ?? null;
    }
    const input = {
      pool_name: poolName,
      pool_address: args.pool_address,
      amount_sol: args.amount_sol,
      strategy: args.strategy,
      lower_bin: result.lower_bin,
      upper_bin: result.upper_bin,
      active_bin: result.active_bin,
      bin_step: args.bin_step ?? result.bin_step ?? null,
    };
    await ctx.repos.decisions.append({
      id: nextId(ctx.clock.now()),
      ts: ctx.clock.now().toISOString(),
      type: "deploy",
      actor,
      pool: args.pool_address,
      pool_name: sanitizeDecisionText(poolName, 120),
      position: result.position_address,
      summary: sanitizeDecisionText(formatDeploySummary(input)),
      reason: sanitizeDecisionText(callerRationale ?? formatDeployReason(input), 500),
      risks: [],
      metrics: {
        amount_sol: args.amount_sol,
        active_bin: result.active_bin,
        lower_bin: result.lower_bin,
        upper_bin: result.upper_bin,
        ...(input.bin_step != null ? { bin_step: input.bin_step } : {}),
        ...(lessonsApplied.length ? { lessons_applied: lessonsApplied } : {}),
      },
      rejected: [],
    });
  };
}

/** Post-hook: append a close decision after every successful close_position call. */
export function logCloseDecision(defaultActor: DecisionActor): PostHook<{ position_address: string; reason: string }, CloseResult> {
  return async (args, result, ctx) => {
    if (!result.success) return;
    // Same per-call attribution as deploys — bridge / screening / management can
    // scope ctx with deployMeta to tag the true actor + carry Sage's rationale.
    const actor = ctx.deployMeta?.actor ?? defaultActor;
    const callerRationale = ctx.deployMeta?.rationale?.trim() || null;
    // Enrich pool_name from the tracked position — the close_position tool doesn't
    // receive it in args, but track-position wrote it at deploy time.
    const tracked = await ctx.repos.positions.get(args.position_address);
    const poolName = tracked?.pool_name ?? null;
    const input = {
      pool_name: poolName,
      position_address: args.position_address,
      final_pnl_pct: result.final_pnl_pct,
      final_value_usd: result.final_value_usd,
      fees_earned_usd: result.fees_earned_usd,
      reason: result.reason || args.reason,
    };
    await ctx.repos.decisions.append({
      id: nextId(ctx.clock.now()),
      ts: ctx.clock.now().toISOString(),
      type: "close",
      actor,
      pool: result.pool_address,
      pool_name: sanitizeDecisionText(poolName, 120),
      position: args.position_address,
      summary: sanitizeDecisionText(formatCloseSummary(input)),
      reason: sanitizeDecisionText(callerRationale ?? formatCloseReason(input), 500),
      risks: [],
      metrics: {
        pnl_pct: result.final_pnl_pct,
        final_value_usd: result.final_value_usd,
        fees_earned_usd: result.fees_earned_usd,
      },
      rejected: [],
    });
  };
}
