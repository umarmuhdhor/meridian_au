// Config-form catalog for the dashboard. Kept in lockstep with `FlatUserConfigSchema`
// (src/domain/schemas/config-flat.ts). Every `key` here must be a real key on that
// schema — `update_config` rejects unknowns.
//
// Grouped into six operator-facing tabs (post-audit 2026-08-04): Screening,
// Deploy, Exit, Rebalance & Sweep, Automation, Integrations. Advanced plumbing
// lives in `user-config.json` and is intentionally NOT surfaced here.
//
// `unit`   — magnitude/currency suffix shown next to the field.
// `help`   — hover tooltip.
// `options`— renders a <select> (values MUST match the Zod enum or saves reject).
// `readOnly` — displayed but not editable (informational).

export type ConfigType = "number" | "boolean" | "string" | "array";

export interface ConfigField {
  key: string;
  group: ConfigGroup;
  type: ConfigType;
  secret?: boolean;
  readOnly?: boolean;
  unit?: string;
  help?: string;
  options?: readonly string[];
}

export const CONFIG_GROUPS = [
  "screening",
  "deploy",
  "exit",
  "rebalance",
  "automation",
  "follow",
  "integrations",
] as const;
export type ConfigGroup = (typeof CONFIG_GROUPS)[number];

export const GROUP_LABELS: Record<ConfigGroup, string> = {
  screening: "Screening",
  deploy: "Deploy",
  exit: "Exit rules",
  rebalance: "Rebalance & Sweep",
  automation: "Automation",
  follow: "Follow wallet",
  integrations: "Integrations",
};

export const GROUP_HELP: Record<ConfigGroup, string> = {
  screening: "Which pools qualify. Runs before any deploy decision.",
  deploy: "How much to put in per position, and Sage's fallback strategy.",
  exit: "When positions close automatically. Deterministic — Sage does not race these.",
  rebalance: "Fee claiming, dust sweeping, and low-yield closes.",
  automation: "Cron cadence and LLM model choices.",
  follow: "Copy-trade a chosen wallet. Bypasses screening, the TA gate, cooldowns and blacklists by design — add wallets on the Follow page.",
  integrations: "External endpoints and API keys.",
};

const f = (key: string, type: ConfigType, group: ConfigGroup, extra: Partial<ConfigField> = {}): ConfigField => ({
  key,
  type,
  group,
  ...extra,
});

export const CONFIG_FIELDS: ConfigField[] = [
  // ── screening ──
  f("minFeeActiveTvlRatio", "number", "screening", { unit: "ratio", help: "Min fee ÷ active-TVL. 0.12 = fees must be ≥ 12% of active TVL." }),
  f("excludeHighSupplyConcentration", "boolean", "screening", { help: "Reject tokens the datapi flags as high supply concentration." }),
  f("minTvl", "number", "screening", { unit: "USD", help: "Min pool TVL, in raw dollars (20000 = $20,000)." }),
  f("maxTvl", "number", "screening", { unit: "USD", help: "Max pool TVL, in dollars (250000 = $250,000)." }),
  f("minVolume", "number", "screening", { unit: "USD", help: "Min trading volume over `timeframe`, in dollars (800 = $800)." }),
  f("minOrganic", "number", "screening", { unit: "score 0–100", help: "Min base-token organic score (datapi, 0–100)." }),
  f("minQuoteOrganic", "number", "screening", { unit: "score 0–100", help: "Min quote-token organic score (0–100)." }),
  f("minHolders", "number", "screening", { unit: "count", help: "Min number of base-token holders." }),
  f("minMcap", "number", "screening", { unit: "USD", help: "Min market cap, in dollars (700000 = $700k)." }),
  f("maxMcap", "number", "screening", { unit: "USD", help: "Max market cap, in dollars (15000000 = $15M)." }),
  f("minBinStep", "number", "screening", { unit: "bins", help: "Min DLMM bin step (price granularity; discrete, e.g. 20/50/80/100/125)." }),
  f("maxBinStep", "number", "screening", { unit: "bins", help: "Max DLMM bin step." }),
  f("timeframe", "string", "screening", { options: ["5m", "1h", "6h", "24h"], help: "Datapi stats window used for volume/fee metrics." }),
  f("category", "string", "screening", { help: "Datapi pool category filter (e.g. trending)." }),
  f("maxBotHoldersPct", "number", "screening", { unit: "%", help: "Max % of holders flagged as bots (0–100). Enforced post-diligence." }),
  f("maxTop10Pct", "number", "screening", { unit: "%", help: "Max % of supply held by the top-10 wallets (0–100). Enforced post-diligence." }),
  f("maxAtrPct", "number", "screening", { unit: "%", help: "Max 1h/5m ATR%. Rejects wild rollercoaster pools. e.g. 20 = swings >20% per candle avg = skip." }),
  f("maxSpikePct", "number", "screening", { unit: "%", help: "Max last-candle spike% when at local top. e.g. 25 = >25% jump AND at peak = skip (don't buy the top)." }),
  f("rejectOnMissingTrend", "boolean", "screening", { help: "Reject pools with no OHLCV history (brand-new). true = safer, false = catch early launches." }),
  f("capitulationFromHighPct", "number", "screening", { unit: "%", help: "Capitulation gate — how deep from window high counts as 'deep drop'. 40 = >40% drop. ALL 3 capitulation knobs must trigger to reject." }),
  f("capitulationSupportDistPct", "number", "screening", { unit: "%", help: "Capitulation gate — how far from nearest support counts as 'no floor'. 10 = support >10% away = no bounce zone." }),
  f("capitulationAtrPct", "number", "screening", { unit: "%", help: "Capitulation gate — how low ATR counts as 'dead vol'. 15 = swings <15% = no fees even on reversal." }),
  f("maxFromHighPct", "number", "screening", { unit: "%", help: "Standalone drawdown veto (TREND-INDEPENDENT). Reject a candidate priced more than this % below its window high on ANY timeframe — even if the last candles bounce (trend=UP). 35 = >35% below high = skip. Catches dead-cat-bounce entries the capitulation gate misses. Set 30 to also veto ~-33% entries." }),
  f("rejectNoFloorDowntrend", "boolean", "screening", { help: "No-floor downtrend veto. Reject when EVERY timeframe trends DOWN AND there's no swing-low support on any timeframe (nearest_support null everywhere = a falling knife with nothing under it). Catches QENIS-class knife-catches the drawdown gate misses (moderate drop, but clearly falling, no floor). true = safer; false = allow Sage's bin-sweep-reversal entries." }),
  f("technicalsWindowShort", "number", "screening", { unit: "candles", help: "Lookback (candles per timeframe) for spike / local-top / from_high / vol_spike. 20 = last 20 candles. Adaptive: for young tokens, shrinks to what's available (floor = minTokenAgeHours or 3)." }),
  f("allowedLaunchpads", "array", "screening", { unit: "list", help: "Comma-separated launchpads to allow. Empty = allow all." }),
  f("blockedLaunchpads", "array", "screening", { unit: "list", help: "Comma-separated launchpads to reject (e.g. letsbonk.fun)." }),
  f("minTokenAgeHours", "number", "screening", { unit: "hours", help: "Min token age in hours. Blank = no floor." }),
  f("maxTokenAgeHours", "number", "screening", { unit: "hours", help: "Max token age in hours. Blank = no ceiling." }),

  // ── deploy ──
  f("deployAmountSol", "number", "deploy", { unit: "SOL", help: "SOL deployed per position. This is both the target size and the cap — one knob." }),
  f("gasReserve", "number", "deploy", { unit: "SOL", help: "SOL kept unspent for transaction fees." }),
  f("maxPositions", "number", "deploy", { unit: "count", help: "Max concurrent open positions the agent will hold." }),
  f("binsBelow", "number", "deploy", { unit: "bins", help: "Bins below the active bin at deploy time (safety floor 35)." }),
  f("strategy", "string", "deploy", { options: ["spot", "curve", "bid_ask"], help: "Fallback AI default only — Sage picks per candidate per cycle. spot = uniform (safe default), curve = concentrated at center, bid_ask = edges (directional thesis only)." }),

  // ── exit rules ──
  f("stopLossPct", "number", "exit", { unit: "%", help: "Close at this PnL loss. Negative, e.g. -50 = -50%." }),
  f("stopLossGraceMinutes", "number", "exit", { unit: "minutes", help: "Suppress stop-loss for this many minutes after deploy — protects fresh single-side entries from opening-slippage IL. Set 0 to disable." }),
  f("takeProfitPct", "number", "exit", { unit: "%", help: "Close at this PnL gain, e.g. 5 = +5%." }),
  f("trailingTakeProfit", "boolean", "exit", { help: "Enable trailing take-profit." }),
  f("trailingTriggerPct", "number", "exit", { unit: "%", help: "Arm the trailing stop once peak PnL reaches this %." }),
  f("trailingDropPct", "number", "exit", { unit: "%", help: "Close if PnL drops this % from its peak (after arming)." }),
  f("outOfRangeWaitMinutes", "number", "exit", { unit: "minutes", help: "How long a position may sit out-of-range before closing." }),

  // ── exit rules · smart-exit regime engine (dark by default) ──
  f("smartExitEnabled", "boolean", "exit", { help: "MASTER SWITCH for the regime-aware exit engine. false = legacy static stopLossPct only. true = CATASTROPHIC/DYING/HEALTHY classification replaces the static stop (take-profit + OOR + low-yield unchanged). Watch the shadow regime logs first, then arm this. Arm sageExitEnabled separately, after." }),
  f("exitHardFloorPct", "number", "exit", { unit: "%", help: "Smart-exit only. Catastrophic floor — ALWAYS close at/below this PnL (unconditional backstop). -25 = -25%. Keep DEEPER than stopLossPct (stopLossPct is the attention threshold; this is the hard cap)." }),
  f("exitOorProxyPct", "number", "exit", { unit: "%", help: "Smart-exit only. 30s poller fast-cut: an out-of-range-BELOW position at/below this PnL closes immediately, without waiting for the 10-min cycle. -12 = -12%." }),
  f("dyingConsecutiveRed", "number", "exit", { unit: "candles", help: "Smart-exit only. N trailing red candles + near-zero fee velocity = DYING = cut early. 4 = four red candles in a row." }),
  f("dyingAtrCollapsePct", "number", "exit", { unit: "%", help: "Smart-exit only. 1h ATR below this = dead vol (nothing to farm even on a reversal). Part of the DYING test. 10 = <10% ATR." }),
  f("healthyFeeVelocityMin", "number", "exit", { unit: "ratio", help: "Smart-exit only. HEALTHY hold: an in-range position earning ≥ this fee/TVL velocity is HELD past the stop to let fees work. 12 ≈ 2× the low-yield floor (minFeePerTvl24h)." }),
  f("sageExitEnabled", "boolean", "exit", { help: "Smart-exit only. Consult Sage on AMBIGUOUS positions (hold-or-cut verdict). false = deterministic conditional fallback (in-range HOLD / out-of-range CLOSE). Requires smartExitEnabled=true. Arm AFTER you trust the deterministic regimes." }),
  f("sageExitCooldownMin", "number", "exit", { unit: "minutes", help: "Smart-exit only. A position escalates to Sage at most once per this many minutes. 20 = 20 min." }),

  // ── rebalance / sweep ──
  f("minFeePerTvl24h", "number", "rebalance", { unit: "ratio", help: "Min 24h fee/TVL before a position is closed as low-yield." }),
  f("minAgeBeforeYieldCheck", "number", "rebalance", { unit: "minutes", help: "Position age before the low-yield rule can close it." }),
  f("minClaimAmount", "number", "rebalance", { unit: "USD", help: "Claim fees once unclaimed fees ≥ this, in dollars." }),
  f("dustSweepEnabled", "boolean", "rebalance", { help: "Enable the periodic dust-sweeper that sells every non-SOL wallet token not held by an open position." }),
  f("dustSweepIntervalMin", "number", "rebalance", { unit: "minutes", help: "How often the dust-sweeper runs." }),

  // ── automation ──
  f("managementIntervalMin", "number", "automation", { unit: "minutes", help: "How often the management cycle runs. Changing this restarts the cron." }),
  f("screeningIntervalMin", "number", "automation", { unit: "minutes", help: "How often the screener runs. Changing this restarts the cron." }),
  f("healthCheckIntervalMin", "number", "automation", { unit: "minutes", help: "Health-check interval. Changing this restarts the cron." }),
  f("solMode", "boolean", "automation", { help: "Denominate PnL/sizing in SOL rather than USD." }),
  f("managementModel", "string", "automation", { unit: "model slug", help: "OpenRouter model for the manager, e.g. minimax/minimax-m2.7. Must be an exact slug." }),
  f("screeningModel", "string", "automation", { unit: "model slug", help: "OpenRouter model for the screener. Must be an exact slug." }),
  f("generalModel", "string", "automation", { unit: "model slug", help: "OpenRouter model for chat / Telegram. Must be an exact slug." }),

  // ── follow the wallet ──
  f("followEnabled", "boolean", "follow", { help: "MASTER SWITCH for copy-trading. When on, every ENABLED followed wallet is polled and its DLMM entries/exits are mirrored. Screening, the TA gate, pool/token cooldowns and both blacklists are bypassed on this path — wallet balance and maxPositions still apply. Off = the watcher is never even started." }),
  f("followIntervalSec", "number", "follow", { unit: "seconds", help: "How often each followed wallet is polled. Lower = faster mirroring, more datapi requests. 45 = every 45s." }),
  f("followPositionSizePct", "number", "follow", { unit: "fraction", help: "Fraction of FREE SOL (balance minus gasReserve) committed per mirrored entry. 0.35 = 35%. Their size is irrelevant — yours scales with your own balance." }),
  f("followMinDeploySol", "number", "follow", { unit: "SOL", help: "Skip the mirror when the sized amount lands below this. Prevents dust positions when the wallet is nearly empty." }),
  f("followMaxDeploySol", "number", "follow", { unit: "SOL", help: "Hard cap per mirrored entry, whatever the percentage works out to." }),
  f("followMinBinsBelow", "number", "follow", { unit: "bins", help: "Floor on the copied range width. May go BELOW the 35-bin screener safety floor — follow copies their range, and many LPs run narrow. 20 = at least 20 bins below the active bin." }),
  f("followMaxBinsBelow", "number", "follow", { unit: "bins", help: "Ceiling on the copied range width. Above 69 bins the deploy uses the multi-tx wide-range path." }),
  f("followFallbackBinsBelow", "number", "follow", { unit: "bins", help: "Width used when datapi does not expose their lower bin. 55 = same default the screener uses." }),
  f("followStrategy", "string", "follow", { options: ["spot", "curve", "bid_ask"], help: "Liquidity shape for mirrored entries. Their shape is not reported by datapi, so this is yours to pick." }),
  f("followLearnEnabled", "boolean", "follow", { help: "After each mirrored close, ask the LLM to infer why the wallet entered and exited, and save it as a tagged lesson. Entry/exit technicals are recorded either way." }),

  // ── integrations ──
  f("hiveMindUrl", "string", "integrations", { unit: "url", help: "Agent Meridian HiveMind base URL. Empty breaks hivemind-sync." }),
  f("hiveMindApiKey", "string", "integrations", { secret: true, help: "HiveMind API key. Shown redacted." }),
  f("agentId", "string", "integrations", { unit: "id", help: "This agent's HiveMind id." }),
  f("hiveMindPullMode", "string", "integrations", { options: ["auto", "manual"], help: "auto = sync every 15m; manual = only on demand." }),
  f("agentMeridianApiUrl", "string", "integrations", { unit: "url", help: "Agent Meridian API base URL (study top LPers)." }),
  f("publicApiKey", "string", "integrations", { secret: true, help: "Study-top-lpers / lpagent API key. Shown redacted." }),
];
