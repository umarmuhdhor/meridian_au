import { z } from "zod";
import { TechnicalsSummarySchema } from "./kline.js";

/**
 * Track record of a lesson: how often the screener cited it in `lessons_applied` when
 * deploying, and how those positions ended. Written by the close review once the
 * position's PnL is settled — never by the LLM, so the counts can't be talked up.
 */
export const LessonStatsSchema = z.object({
  applied: z.number().int().nonnegative().default(0),
  wins: z.number().int().nonnegative().default(0),
  losses: z.number().int().nonnegative().default(0),
  last_applied_at: z.string().nullable().optional(),
});
export type LessonStats = z.infer<typeof LessonStatsSchema>;

export const LessonSchema = z
  .object({
    id: z.string(),
    rule: z.string(),
    tags: z.array(z.string()).default([]),
    outcome: z.string().nullable().optional(),
    sourceType: z.string().nullable().optional(),
    confidence: z.number().nullable().optional(),
    role: z.string().nullable().optional(),
    pinned: z.boolean().default(false),
    context: z.record(z.string(), z.unknown()).nullable().optional(),
    stats: LessonStatsSchema.optional(),
    created_at: z.string().optional(),
    /**
     * Auto lessons only: the machine-checkable condition the lesson applies to (see
     * domain/rules/lesson-match.ts) and how that condition scored on past trades when the
     * lesson was accepted. Optional — manual and older lessons have neither.
     */
    match: z.string().optional(),
    backtest: z
      .object({ wins: z.number().int(), losses: z.number().int(), at: z.string() })
      .optional(),
  })
  .passthrough();
export type Lesson = z.infer<typeof LessonSchema>;

/**
 * What the close review concluded about one closed position. `outcome` comes from the
 * settled numbers; `what`/`why`/`lesson_rule` come from the LLM and are null when it
 * was unavailable or had nothing concrete to say.
 */
export const CloseReviewSchema = z
  .object({
    reviewed_at: z.string(),
    outcome: z.enum(["win", "loss"]),
    net_usd: z.number().nullable().optional(),
    pnl_source: z.string().nullable().optional(),
    what: z.string().nullable().optional(),
    why: z.string().nullable().optional(),
    lesson_id: z.string().nullable().optional(),
    lesson_rule: z.string().nullable().optional(),
    /** Lessons the screener cited at deploy, as they read at review time. */
    lessons_applied: z
      .array(z.object({ id: z.string(), rule: z.string().nullable() }))
      .default([]),
    /** Why no lesson was written, when none was (e.g. "llm_unavailable", "llm_none"). */
    note: z.string().nullable().optional(),
    /** Set when note="rule_too_broad": the backtest result that rejected the proposed rule. */
    rejected_reason: z.string().nullable().optional(),
    /** The LLM that wrote this review (llm.learningModel / learningImportantModel). */
    model: z.string().nullable().optional(),
    /** Set when the review was (re)written by the one-off backfill. */
    backfilled_at: z.string().optional(),
  })
  .passthrough();
export type CloseReview = z.infer<typeof CloseReviewSchema>;

/**
 * Counterfactual replay of a closed position under other liquidity shapes (shadow mode,
 * 2026-10-08) — what the same pool, range and hold would have returned as spot / bid_ask.
 * Observation only: nothing reads it back into a trading decision. Percent units match
 * `pnl_pct`. See domain/rules/strategy-sim.ts for the method and its limits.
 */
export const ShadowReplaySchema = z
  .object({
    method: z.string(),
    computed_at: z.string(),
    actual_strategy: z.enum(["spot", "curve", "bid_ask"]),
    entry_price_sol: z.number(),
    exit_price_sol: z.number(),
    /** Bins the price ended below the entry bin (negative = above entry). */
    exit_bin_offset: z.number(),
    candles: z.number().int().nonnegative(),
    results: z.array(
      z.object({
        strategy: z.enum(["spot", "curve", "bid_ask"]),
        price_pct: z.number(),
        fee_pct: z.number(),
        net_pct: z.number(),
        fee_ratio: z.number(),
      }),
    ),
  })
  .passthrough();
export type ShadowReplay = z.infer<typeof ShadowReplaySchema>;

/**
 * Bounce-exit shadow (2026-10-10) — what a deep-loss close (CATASTROPHIC / OOR-below
 * DYING) would have returned had it waited for a rebound instead of selling at once.
 * Replayed from SOL-quoted 5m candles after the close. Observation only. Percent units
 * match `pnl_pct`. See domain/rules/bounce-exit.ts (`simulateBounceExit`).
 */
export const BounceShadowSchema = z
  .object({
    method: z.string(),
    computed_at: z.string(),
    take_pct: z.number(),
    stop_pct: z.number(),
    timeout_min: z.number(),
    outcome: z.enum(["take", "stop", "timeout"]),
    /** Price at exit ÷ price at the trigger. */
    multiplier: z.number(),
    minutes_to_exit: z.number(),
    candles: z.number().int().nonnegative(),
    actual_net_pct: z.number(),
    shadow_net_pct: z.number(),
    /** shadow − actual, percentage points. Positive = waiting would have paid. */
    delta_pct: z.number(),
  })
  .passthrough();
export type BounceShadow = z.infer<typeof BounceShadowSchema>;

export const PerformanceRecordSchema = z
  .object({
    position: z.string(),
    pool: z.string().optional(),
    pool_name: z.string().nullable().optional(),
    pnl_pct: z.number(),
    pnl_usd: z.number().optional(),
    fees_earned_usd: z.number().nonnegative().optional(),
    initial_value_usd: z.number().optional(),
    final_value_usd: z.number().optional(),
    /**
     * Where the PnL figures came from. `estimate` = last open-position snapshot at close
     * time; `meteora_closed` = Meteora datapi's settled closed-position totals (matches
     * Meteora's own UI). Absent on records written before 2026-09-27 — read as estimate.
     */
    pnl_source: z.enum(["estimate", "meteora_closed"]).optional(),
    range_efficiency: z.number().optional(),
    minutes_held: z.number().int().nonnegative().optional(),
    minutes_in_range: z.number().int().nonnegative().optional(),
    close_reason: z.string(),
    amount_sol: z.number().optional(),
    /** Copied from TrackedPosition so the history row can render without JOINs. */
    strategy: z.enum(["spot", "curve", "bid_ask"]).optional(),
    bin_range: z
      .object({ min: z.number().int(), max: z.number().int() })
      .partial()
      .optional(),
    bin_step: z.number().int().positive().optional(),
    volatility: z.number().nullable().optional(),
    fee_tvl_ratio: z.number().nullable().optional(),
    organic_score: z.number().nullable().optional(),
    /** Market-cap snapshot at deploy time and at close time — for the "mcap in → out" column. */
    entry_mcap: z.number().nullable().optional(),
    exit_mcap: z.number().nullable().optional(),
    /** Pool TVL (USD) at deploy time. Absent on records written before 2026-10-10. */
    entry_tvl: z.number().nullable().optional(),
    /** Base-mint (SPL token) address — persisted so same-token history matches across pools. */
    base_mint: z.string().nullable().optional(),
    /** Base-mint context captured at deploy for later diagnostics. */
    holders_at_entry: z.number().int().nonnegative().nullable().optional(),
    smart_wallets_present: z.boolean().nullable().optional(),
    /** Deterministic close_at time (ISO) so the UI can render without inferring from minutes_held. */
    closed_at: z.string().nullable().optional(),
    signal_snapshot: z.record(z.string(), z.unknown()).nullable().optional(),
    /** Multi-timeframe technicals captured at deploy — feeds retrospective pattern-mining. */
    entry_technicals: z.array(TechnicalsSummarySchema).nullable().optional(),
    /** Multi-timeframe technicals captured at close. */
    exit_technicals: z.array(TechnicalsSummarySchema).nullable().optional(),
    /** The screener's own stated reason for deploying (deploy_position `reason`). */
    entry_reason: z.string().nullable().optional(),
    /** Lesson ids the screener cited at deploy (deploy_position `lessons_applied`). */
    lessons_applied: z.array(z.string()).nullable().optional(),
    /** Post-close review — absent until the close review has processed this record. */
    review: CloseReviewSchema.optional(),
    /** Shadow-mode counterfactual — absent when the replay could not be computed. */
    shadow: ShadowReplaySchema.optional(),
    /** Bounce-exit counterfactual — only on deep-loss closes, once the replay window has passed. */
    bounce_shadow: BounceShadowSchema.optional(),
    recorded_at: z.string(),
  })
  .passthrough();
export type PerformanceRecord = z.infer<typeof PerformanceRecordSchema>;

export const LessonFileSchema = z.object({
  lessons: z.array(LessonSchema).default([]),
  performance: z.array(PerformanceRecordSchema).default([]),
});
export type LessonFile = z.infer<typeof LessonFileSchema>;

export function emptyLessonFile(): LessonFile {
  return { lessons: [], performance: [] };
}
