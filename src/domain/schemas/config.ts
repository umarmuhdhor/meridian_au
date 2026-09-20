import { z } from "zod";

export const ManagementConfigSchema = z.object({
  stopLossPct: z.number(),
  /** Minutes after deploy during which rule-1 (stop_loss) is suppressed.
   *  Prevents opening-slippage IL from auto-closing single-side SOL entries
   *  before fees can accumulate. 0 disables the grace window. */
  stopLossGraceMinutes: z.number().int().nonnegative().default(30),
  takeProfitPct: z.number(),
  outOfRangeWaitMinutes: z.number().int().nonnegative(),
  minFeePerTvl24h: z.number().nonnegative(),
  minAgeBeforeYieldCheck: z.number().int().nonnegative(),
  minClaimAmount: z.number().nonnegative(),
  trailingTakeProfit: z.boolean(),
  trailingTriggerPct: z.number(),
  trailingDropPct: z.number().positive(),
  deployAmountSol: z.number().positive(),
  gasReserve: z.number().nonnegative(),
  positionSizePct: z.number().positive().max(1),
  pnlSanityMaxDiffPct: z.number().positive(),
  solMode: z.boolean(),
  autoSwapSlippageBps: z.number().int().min(1).max(10_000).default(300),
  autoSwapMinUsd: z.number().nonnegative().default(0.5),
  consolidateRetries: z.number().int().min(1).max(20).default(5),
  consolidateRetryDelayMs: z.number().int().min(0).max(30_000).default(3_000),
  dustSweepEnabled: z.boolean().default(true),
  dustSweepIntervalMin: z.number().int().min(1).max(1440).default(5),
  dustSweepMinUsd: z.number().nonnegative().default(0.01),
  dustSweepSlippageBps: z.number().int().min(1).max(10_000).default(500),
  repeatDeployCooldownEnabled: z.boolean().default(true),
  repeatDeployCooldownHours: z.number().nonnegative().default(12),
  repeatDeployCooldownScope: z.enum(["pool", "token"]).default("token"),
  // Smart-exit regime engine — see config-flat.ts for semantics. Dark-launched.
  smartExitEnabled: z.boolean().default(false),
  exitHardFloorPct: z.number().default(-25),
  exitOorProxyPct: z.number().default(-12),
  dyingConsecutiveRed: z.number().int().min(1).default(4),
  dyingAtrCollapsePct: z.number().min(0).default(10),
  healthyFeeVelocityMin: z.number().nonnegative().default(12),
  sageExitEnabled: z.boolean().default(false),
  sageExitCooldownMin: z.number().int().min(1).default(20),
});
export type ManagementConfig = z.infer<typeof ManagementConfigSchema>;

export const RiskConfigSchema = z.object({
  maxPositions: z.number().int().positive(),
});
export type RiskConfig = z.infer<typeof RiskConfigSchema>;

export const StrategyConfigSchema = z.object({
  /** AI default only — Sage overrides per candidate. Kept for legacy fallback + Telegram REPL. */
  strategy: z.enum(["spot", "curve", "bid_ask"]),
  binsBelow: z.number().int().min(35),
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export const ScheduleConfigSchema = z.object({
  managementIntervalMin: z.number().int().positive(),
  screeningIntervalMin: z.number().int().positive(),
  healthCheckIntervalMin: z.number().int().positive(),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

/** Screening filters — mirrors config.js `screening` section (flat keys in user-config.json). */
export const ScreeningConfigSchema = z.object({
  excludeHighSupplyConcentration: z.boolean(),
  minFeeActiveTvlRatio: z.number().nonnegative(),
  minTvl: z.number().nonnegative(),
  maxTvl: z.number().nonnegative(),
  minVolume: z.number().nonnegative(),
  minOrganic: z.number().nonnegative(),
  minQuoteOrganic: z.number().nonnegative(),
  minHolders: z.number().int().nonnegative(),
  minMcap: z.number().nonnegative(),
  maxMcap: z.number().nonnegative(),
  minBinStep: z.number().int().nonnegative(),
  maxBinStep: z.number().int().nonnegative(),
  timeframe: z.string(),
  category: z.string(),
  maxBotHoldersPct: z.number().min(0).max(100),
  maxTop10Pct: z.number().min(0).max(100),
  maxAtrPct: z.number().min(0),
  maxSpikePct: z.number().min(0),
  rejectOnMissingTrend: z.boolean(),
  capitulationFromHighPct: z.number().min(0),
  capitulationSupportDistPct: z.number().min(0),
  capitulationAtrPct: z.number().min(0),
  maxFromHighPct: z.number().min(0),
  rejectNoFloorDowntrend: z.boolean(),
  technicalsWindowShort: z.number().int().min(3),
  allowedLaunchpads: z.array(z.string()),
  blockedLaunchpads: z.array(z.string()),
  minTokenAgeHours: z.number().nonnegative().nullable(),
  maxTokenAgeHours: z.number().nonnegative().nullable(),
});
export type ScreeningConfig = z.infer<typeof ScreeningConfigSchema>;

export const LlmConfigSchema = z.object({
  temperature: z.number().min(0),
  maxTokens: z.number().int().positive(),
  maxSteps: z.number().int().positive(),
  managementModel: z.string(),
  screeningModel: z.string(),
  generalModel: z.string(),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const HiveMindConfigSchema = z.object({
  url: z.string(),
  apiKey: z.string(),
  agentId: z.string(),
  pullMode: z.enum(["auto", "manual"]),
});
export type HiveMindConfig = z.infer<typeof HiveMindConfigSchema>;

export const ApiConfigSchema = z.object({
  url: z.string(),
  publicApiKey: z.string(),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export const JupiterConfigSchema = z.object({
  referralAccount: z.string().default(""),
  referralFeeBps: z.number().int().min(0).max(10_000).default(50),
});
export type JupiterConfig = z.infer<typeof JupiterConfigSchema>;

/** Canonical Solana mint addresses — used by swap normalization + reference. */
export const TokensConfigSchema = z.object({
  SOL: z.string().default("So11111111111111111111111111111111111111112"),
  USDC: z.string().default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  USDT: z.string().default("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
});
export type TokensConfig = z.infer<typeof TokensConfigSchema>;

/**
 * Follow-the-wallet. Mirrors a chosen wallet's DLMM entries and exits verbatim,
 * deliberately routing around screening, the TA gate, cooldowns and blacklists —
 * the user's judgement about the wallet replaces the bot's judgement about the pool.
 * Off by default; arming it is a two-step (global `enabled` + per-wallet `enabled`).
 */
export const FollowConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Poll cadence. Copy-trading latency is the whole game, so this is seconds, not minutes. */
  intervalSec: z.number().int().min(15).max(3600).default(45),
  /** Fraction of post-gas-reserve free SOL committed per mirrored entry. */
  positionSizePct: z.number().positive().max(1).default(0.35),
  minDeploySol: z.number().positive().default(0.05),
  maxDeploySol: z.number().positive().default(1),
  /** Bounds the copied bin width is clamped into. minBinsBelow may go under
   *  MIN_SAFE_BINS_BELOW — that floor is the screener's, and follow waives it. */
  minBinsBelow: z.number().int().min(1).default(20),
  maxBinsBelow: z.number().int().min(1).max(400).default(120),
  /** Used when datapi does not expose their lower bin. */
  fallbackBinsBelow: z.number().int().min(1).max(400).default(55),
  strategy: z.enum(["spot", "curve", "bid_ask"]).default("spot"),
  /**
   * The followed wallet owns the exit. When true, mirrored positions are exempt from
   * EVERY local close rule — stop-loss, take-profit, trailing-TP, OOR, low-yield and
   * the smart-exit engine — so only the source wallet's exit closes them. Fee CLAIMS
   * still run. Turning this off hands mirrored positions back to the normal exit rules,
   * which will close them independently of the wallet being followed.
   */
  exclusiveExit: z.boolean().default(true),
  /** Consecutive degraded snapshots for one wallet before an alert is raised. */
  staleTicksBeforeAlert: z.number().int().min(1).default(5),
  /**
   * Cap on concurrent mirrors, independent of risk.maxPositions. Mirrors have no local
   * exit under `exclusiveExit`, so without their own cap they can hold every portfolio
   * slot indefinitely and starve screening. Keep it below maxPositions to reserve room.
   */
  maxMirrored: z.number().int().min(1).default(2),
  /**
   * Close and re-mirror when the followed wallet re-centers inside a pool it stays in.
   * A pool-membership diff cannot see that on its own, and `exclusiveExit` has disabled
   * the out-of-range rule that used to clean up the stranded range.
   */
  mirrorRecenter: z.boolean().default(true),
  /** Bin drift below which a range change is treated as noise, not a re-center. */
  recenterBinThreshold: z.number().int().min(1).default(10),
  /** Run the entry/exit retrospective and write a lesson after each mirrored close. */
  learnEnabled: z.boolean().default(true),
});
export type FollowConfig = z.infer<typeof FollowConfigSchema>;

export const AppConfigSchema = z.object({
  risk: RiskConfigSchema,
  management: ManagementConfigSchema,
  strategy: StrategyConfigSchema,
  schedule: ScheduleConfigSchema,
  screening: ScreeningConfigSchema,
  llm: LlmConfigSchema,
  hiveMind: HiveMindConfigSchema,
  api: ApiConfigSchema,
  jupiter: JupiterConfigSchema,
  tokens: TokensConfigSchema,
  follow: FollowConfigSchema,
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const MIN_SAFE_BINS_BELOW = 35 as const;
