import { z } from "zod";
import { TechnicalsSummarySchema } from "./kline.js";

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
    created_at: z.string().optional(),
  })
  .passthrough();
export type Lesson = z.infer<typeof LessonSchema>;

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
