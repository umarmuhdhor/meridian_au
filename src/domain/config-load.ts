import { AppConfigSchema, type AppConfig } from "./schemas/config.js";
import { FlatUserConfigSchema, type FlatUserConfig } from "./schemas/config-flat.js";
import { err, ok, type Result } from "../shared/result.js";
import { z } from "zod";

export type ConfigLoadError =
  | { kind: "flat_invalid"; issues: z.ZodIssue[] }
  | { kind: "nested_invalid"; issues: z.ZodIssue[] };

/**
 * Pure — map the flat user-config.json shape to the nested AppConfig the domain reads.
 */
export function flatToNested(flat: FlatUserConfig): AppConfig {
  return {
    risk: {
      maxPositions: flat.maxPositions,
    },
    management: {
      stopLossPct: flat.stopLossPct,
      stopLossGraceMinutes: flat.stopLossGraceMinutes,
      takeProfitPct: flat.takeProfitPct,
      outOfRangeWaitMinutes: flat.outOfRangeWaitMinutes,
      minFeePerTvl24h: flat.minFeePerTvl24h,
      minAgeBeforeYieldCheck: flat.minAgeBeforeYieldCheck,
      minClaimAmount: flat.minClaimAmount,
      trailingTakeProfit: flat.trailingTakeProfit,
      trailingTriggerPct: flat.trailingTriggerPct,
      trailingDropPct: flat.trailingDropPct,
      deployAmountSol: flat.deployAmountSol,
      gasReserve: flat.gasReserve,
      positionSizePct: flat.positionSizePct,
      pnlSanityMaxDiffPct: flat.pnlSanityMaxDiffPct,
      solMode: flat.solMode,
      autoSwapSlippageBps: flat.autoSwapSlippageBps,
      autoSwapMinUsd: flat.autoSwapMinUsd,
      consolidateRetries: flat.consolidateRetries,
      consolidateRetryDelayMs: flat.consolidateRetryDelayMs,
      dustSweepEnabled: flat.dustSweepEnabled,
      dustSweepIntervalMin: flat.dustSweepIntervalMin,
      dustSweepMinUsd: flat.dustSweepMinUsd,
      dustSweepSlippageBps: flat.dustSweepSlippageBps,
      repeatDeployCooldownEnabled: flat.repeatDeployCooldownEnabled,
      repeatDeployCooldownHours: flat.repeatDeployCooldownHours,
      repeatDeployCooldownScope: flat.repeatDeployCooldownScope,
      smartExitEnabled: flat.smartExitEnabled,
      exitHardFloorPct: flat.exitHardFloorPct,
      exitOorProxyPct: flat.exitOorProxyPct,
      dyingConsecutiveRed: flat.dyingConsecutiveRed,
      dyingAtrCollapsePct: flat.dyingAtrCollapsePct,
      healthyFeeVelocityMin: flat.healthyFeeVelocityMin,
      sageExitEnabled: flat.sageExitEnabled,
      sageExitCooldownMin: flat.sageExitCooldownMin,
    },
    strategy: {
      strategy: flat.strategy,
      binsBelow: flat.binsBelow,
    },
    schedule: {
      managementIntervalMin: flat.managementIntervalMin,
      screeningIntervalMin: flat.screeningIntervalMin,
      healthCheckIntervalMin: flat.healthCheckIntervalMin,
    },
    screening: {
      excludeHighSupplyConcentration: flat.excludeHighSupplyConcentration,
      minFeeActiveTvlRatio: flat.minFeeActiveTvlRatio,
      minTvl: flat.minTvl,
      maxTvl: flat.maxTvl,
      minVolume: flat.minVolume,
      minOrganic: flat.minOrganic,
      minQuoteOrganic: flat.minQuoteOrganic,
      minHolders: flat.minHolders,
      minMcap: flat.minMcap,
      maxMcap: flat.maxMcap,
      minBinStep: flat.minBinStep,
      maxBinStep: flat.maxBinStep,
      timeframe: flat.timeframe,
      category: flat.category,
      maxBotHoldersPct: flat.maxBotHoldersPct,
      maxTop10Pct: flat.maxTop10Pct,
      maxAtrPct: flat.maxAtrPct,
      maxSpikePct: flat.maxSpikePct,
      rejectOnMissingTrend: flat.rejectOnMissingTrend,
      capitulationFromHighPct: flat.capitulationFromHighPct,
      capitulationSupportDistPct: flat.capitulationSupportDistPct,
      capitulationAtrPct: flat.capitulationAtrPct,
      maxFromHighPct: flat.maxFromHighPct,
      rejectNoFloorDowntrend: flat.rejectNoFloorDowntrend,
      technicalsWindowShort: flat.technicalsWindowShort,
      allowedLaunchpads: flat.allowedLaunchpads,
      blockedLaunchpads: flat.blockedLaunchpads,
      minTokenAgeHours: flat.minTokenAgeHours,
      maxTokenAgeHours: flat.maxTokenAgeHours,
    },
    follow: {
      enabled: flat.followEnabled,
      intervalSec: flat.followIntervalSec,
      positionSizePct: flat.followPositionSizePct,
      minDeploySol: flat.followMinDeploySol,
      maxDeploySol: flat.followMaxDeploySol,
      minBinsBelow: flat.followMinBinsBelow,
      maxBinsBelow: flat.followMaxBinsBelow,
      fallbackBinsBelow: flat.followFallbackBinsBelow,
      strategy: flat.followStrategy,
      exclusiveExit: flat.followExclusiveExit,
      staleTicksBeforeAlert: flat.followStaleTicksBeforeAlert,
      learnEnabled: flat.followLearnEnabled,
    },
    llm: {
      temperature: flat.temperature,
      maxTokens: flat.maxTokens,
      maxSteps: flat.maxSteps,
      managementModel: flat.managementModel,
      screeningModel: flat.screeningModel,
      generalModel: flat.generalModel,
    },
    hiveMind: {
      url: flat.hiveMindUrl,
      apiKey: flat.hiveMindApiKey,
      agentId: flat.agentId,
      pullMode: flat.hiveMindPullMode,
    },
    api: {
      url: flat.agentMeridianApiUrl,
      publicApiKey: flat.publicApiKey,
    },
    jupiter: {
      referralAccount: flat.jupiterReferralAccount,
      referralFeeBps: flat.jupiterReferralFeeBps,
    },
    tokens: {
      SOL: "So11111111111111111111111111111111111111112",
      USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    },
  };
}

/**
 * Full pipeline: raw JSON → validated flat → nested AppConfig → validated again.
 * Both validation stages surface Zod issues.
 */
export function parseAppConfig(raw: unknown): Result<AppConfig, ConfigLoadError> {
  const flat = FlatUserConfigSchema.safeParse(raw);
  if (!flat.success) return err({ kind: "flat_invalid", issues: flat.error.issues });
  const nested = AppConfigSchema.safeParse(flatToNested(flat.data));
  if (!nested.success) return err({ kind: "nested_invalid", issues: nested.error.issues });
  return ok(nested.data);
}

/**
 * Rebuild the flat file from a nested AppConfig — used by `update_config` writeback.
 * Callers merge with the original flat to preserve any passthrough keys.
 */
export function nestedToFlat(nested: AppConfig): Partial<FlatUserConfig> {
  return {
    ...nested.risk,
    ...nested.management,
    ...nested.strategy,
    ...nested.schedule,
    ...nested.screening,
    ...nested.llm,
    hiveMindUrl: nested.hiveMind.url,
    hiveMindApiKey: nested.hiveMind.apiKey,
    agentId: nested.hiveMind.agentId,
    hiveMindPullMode: nested.hiveMind.pullMode,
    agentMeridianApiUrl: nested.api.url,
    publicApiKey: nested.api.publicApiKey,
    jupiterReferralAccount: nested.jupiter.referralAccount,
    jupiterReferralFeeBps: nested.jupiter.referralFeeBps,
    followEnabled: nested.follow.enabled,
    followIntervalSec: nested.follow.intervalSec,
    followPositionSizePct: nested.follow.positionSizePct,
    followMinDeploySol: nested.follow.minDeploySol,
    followMaxDeploySol: nested.follow.maxDeploySol,
    followMinBinsBelow: nested.follow.minBinsBelow,
    followMaxBinsBelow: nested.follow.maxBinsBelow,
    followFallbackBinsBelow: nested.follow.fallbackBinsBelow,
    followStrategy: nested.follow.strategy,
    followExclusiveExit: nested.follow.exclusiveExit,
    followStaleTicksBeforeAlert: nested.follow.staleTicksBeforeAlert,
    followLearnEnabled: nested.follow.learnEnabled,
  };
}
