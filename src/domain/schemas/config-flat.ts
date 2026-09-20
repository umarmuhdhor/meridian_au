import { z } from "zod";

/**
 * The raw shape of user-config.json as it exists on disk today — a flat bag of keys.
 * We accept unknown extras via `.passthrough()` so encrypted / experimental keys pass
 * through untouched; the domain layer reads only what it knows about.
 *
 * Kept intentionally minimal — only keys the daemon actually reads. Config-audit
 * (2026-08-04) removed ~40 keys that had zero read sites in `src/`, and collapsed
 * three overlaps (`risk.maxDeployAmount` → merged into `deployAmountSol`,
 * `outOfRangeBinsToClose` dropped in favour of the time trigger, `maxBinsBelow` /
 * `minBinsBelow` collapsed into a single `binsBelow`).
 */
export const FlatUserConfigSchema = z
  .object({
    // risk / management
    maxPositions: z.number().int().positive(),
    stopLossPct: z.number(),
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
    /** Telegram `/deploy` REPL-only — fraction of wallet SOL sized per position. */
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

    // redeploy cooldown — every successful close writes cooldown_until on the pool
    // memory entry so the same pool can't be redeployed inside the window. scope
    // "token" also writes base_mint_cooldown_until (blocks ALL pools for that token).
    // Prevents the "daemon redeployed a token Sage just closed at a loss" class of bug.
    repeatDeployCooldownEnabled: z.boolean().default(true),
    repeatDeployCooldownHours: z.number().nonnegative().default(12),
    repeatDeployCooldownScope: z.enum(["pool", "token"]).default("token"),

    // ── Smart-exit regime engine (deploy/SPEC-2026-08-29-smart-exit-regime-engine.md)
    // Replaces the static rule-1 stop with a regime classifier. DARK-LAUNCHED:
    // smartExitEnabled=false → exit behavior is exactly the legacy static stop, and
    // the regime is still classified + logged (shadow) for observability before arming.
    smartExitEnabled: z.boolean().default(false),
    // CATASTROPHIC floor — unconditional close (management + poller). Backstop.
    exitHardFloorPct: z.number().default(-25),
    // Poller (30s) fast-cut proxy: OOR-below AND pnl below this → close without OHLCV.
    exitOorProxyPct: z.number().default(-12),
    // DYING: N trailing red candles (c<o) + near-zero fee velocity → close.
    dyingConsecutiveRed: z.number().int().min(1).default(4),
    // DYING: 1h ATR% below this = dead vol (nothing to farm even on a reversal).
    dyingAtrCollapsePct: z.number().min(0).default(10),
    // HEALTHY: hold in-range positions past paper loss only when fee_per_tvl_24h ≥ this.
    healthyFeeVelocityMin: z.number().nonnegative().default(12),
    // Consult Sage on AMBIGUOUS positions. When false, AMBIGUOUS uses the conditional
    // deterministic fallback (in-range→HOLD, OOR/deep→CLOSE).
    sageExitEnabled: z.boolean().default(false),
    // A position escalates to Sage at most once per this many minutes.
    sageExitCooldownMin: z.number().int().min(1).default(20),

    // strategy — Sage picks per candidate (see screening/cycle.ts). `strategy` here
    // is only the fallback for legacy positions / Telegram REPL, and the label the
    // dashboard shows as the "AI default".
    strategy: z.enum(["spot", "curve", "bid_ask"]),
    binsBelow: z.number().int().min(35),

    // schedule
    managementIntervalMin: z.number().int().positive(),
    screeningIntervalMin: z.number().int().positive(),
    healthCheckIntervalMin: z.number().int().positive(),

    // screening
    excludeHighSupplyConcentration: z.boolean().default(true),
    minFeeActiveTvlRatio: z.number().nonnegative().default(0.05),
    minTvl: z.number().nonnegative().default(10_000),
    maxTvl: z.number().nonnegative().default(150_000),
    minVolume: z.number().nonnegative().default(500),
    minOrganic: z.number().nonnegative().default(60),
    minQuoteOrganic: z.number().nonnegative().default(60),
    minHolders: z.number().int().nonnegative().default(500),
    minMcap: z.number().nonnegative().default(150_000),
    maxMcap: z.number().nonnegative().default(10_000_000),
    minBinStep: z.number().int().nonnegative().default(80),
    maxBinStep: z.number().int().nonnegative().default(125),
    timeframe: z.string().default("5m"),
    category: z.string().default("trending"),
    maxBotHoldersPct: z.number().min(0).max(100).default(30),
    maxTop10Pct: z.number().min(0).max(100).default(60),
    maxAtrPct: z.number().min(0).default(20),
    maxSpikePct: z.number().min(0).default(25),
    rejectOnMissingTrend: z.boolean().default(true),
    // Capitulation gate — replaces the binary "every-timeframe DOWN" veto with a
    // magnitude+context check. Rejects only when ALL true on 1h: trend=DOWN AND
    // from_window_high_pct < -capitulationFromHighPct AND support_distance_pct >
    // capitulationSupportDistPct AND atr_pct < capitulationAtrPct. Shallow dip,
    // near-support, or high-vol downtrends pass — those are the reversal / bin-sweep
    // setups DLMM farms fees from.
    capitulationFromHighPct: z.number().min(0).default(40),
    capitulationSupportDistPct: z.number().min(0).default(10),
    capitulationAtrPct: z.number().min(0).default(15),
    // Standalone drawdown veto — TREND-INDEPENDENT. Rejects any candidate whose
    // close is more than `maxFromHighPct`% below its window high on ANY timeframe,
    // regardless of a bounce reading trend=UP. Added 2026-08-29 after Zoe/GTA6/Morty
    // (entries at -50/-41/-33% from high on a 1h dead-cat bounce) all stop-lossed:
    // the capitulation gate never fired because it was gated behind trend===DOWN.
    maxFromHighPct: z.number().min(0).default(35),
    // No-floor downtrend veto — reject when EVERY present timeframe trends DOWN AND
    // no swing-low support exists on ANY candle-bearing timeframe (nearest_support null
    // everywhere = a falling knife with nothing under it). Added 2026-08-31 after QENIS
    // -17%: both TFs DOWN, support null on 15m+1h, 8-candle red streak — Sage
    // rationalized it as a "bin-sweep reversal" and knife-caught it. from_high was only
    // -22% so the drawdown gate (< -35) couldn't catch it. A downtrend with no floor is
    // not a bin-sweep. Code-enforced so Sage cannot override it with a thesis.
    rejectNoFloorDowntrend: z.boolean().default(true),
    // Technicals lookback (candles per timeframe). Controls spike_pct, at_local_top/bottom,
    // from_window_high_pct, vol_spike. Adaptive: for tokens younger than windowShort candles,
    // shrinks to min(windowShort, candles.length). Floor = `minTokenAgeHours` (or 3 if null).
    technicalsWindowShort: z.number().int().min(3).default(20),
    allowedLaunchpads: z.array(z.string()).default([]),
    blockedLaunchpads: z.array(z.string()).default([]),
    minTokenAgeHours: z.number().nonnegative().nullable().default(null),
    maxTokenAgeHours: z.number().nonnegative().nullable().default(null),

    // follow-the-wallet — see FollowConfigSchema for semantics. All defaulted so an
    // existing user-config.json picks them up at boot without a manual edit.
    followEnabled: z.boolean().default(false),
    followIntervalSec: z.number().int().min(15).max(3600).default(45),
    followPositionSizePct: z.number().positive().max(1).default(0.35),
    followMinDeploySol: z.number().positive().default(0.05),
    followMaxDeploySol: z.number().positive().default(1),
    followMinBinsBelow: z.number().int().min(1).default(20),
    followMaxBinsBelow: z.number().int().min(1).max(400).default(120),
    followFallbackBinsBelow: z.number().int().min(1).max(400).default(55),
    followStrategy: z.enum(["spot", "curve", "bid_ask"]).default("spot"),
    followLearnEnabled: z.boolean().default(true),

    // llm
    temperature: z.number().min(0).default(0.373),
    maxTokens: z.number().int().positive().default(4096),
    maxSteps: z.number().int().positive().default(20),
    managementModel: z.string().default("healer-alpha"),
    screeningModel: z.string().default("hunter-alpha"),
    generalModel: z.string().default("healer-alpha"),

    // hiveMind
    hiveMindUrl: z.string().default("https://api.agentmeridian.xyz"),
    hiveMindApiKey: z.string().default(""),
    agentId: z.string().default(""),
    hiveMindPullMode: z.enum(["auto", "manual"]).default("auto"),

    // api
    agentMeridianApiUrl: z.string().default("https://api.agentmeridian.xyz/api"),
    publicApiKey: z.string().default(""),

    // jupiter — env-driven; kept optional in the flat file
    jupiterReferralAccount: z.string().default(""),
    jupiterReferralFeeBps: z.number().int().min(0).max(10_000).default(50),
  })
  .passthrough();
export type FlatUserConfig = z.infer<typeof FlatUserConfigSchema>;
