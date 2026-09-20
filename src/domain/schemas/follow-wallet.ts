import { z } from "zod";
import { TechnicalsSummarySchema } from "./kline.js";

/**
 * A wallet Meridian mirrors. `enabled` is the per-wallet on/off switch; the
 * global switch is `follow.enabled` in AppConfig. Both must be true for a
 * wallet to be polled.
 */
export const FollowedWalletSchema = z.object({
  address: z.string().min(32),
  label: z.string().default(""),
  enabled: z.boolean().default(true),
  addedAt: z.string(),
  /**
   * Per-wallet override of `follow.positionSizePct` (fraction of free SOL to
   * deploy per mirrored open). Null = use the global value.
   */
  sizePctOverride: z.number().positive().max(1).nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type FollowedWallet = z.infer<typeof FollowedWalletSchema>;

/**
 * One mirrored position: the link between THEIR position and OURS. Written on a
 * successful mirror-open, read by the close-diff, and finalised on mirror-close.
 *
 * Every field after `opened_at` is optional so records written by older builds
 * keep loading (see CLAUDE.md § "New persisted-schema fields MUST be optional").
 */
export const MirroredPositionSchema = z
  .object({
    /** Our position address (what we close). */
    position: z.string(),
    /** Pool both sides are in. */
    pool: z.string(),
    pool_name: z.string().nullable().default(null),
    base_mint: z.string().nullable().default(null),
    /** Which followed wallet triggered this. */
    source_wallet: z.string(),
    source_label: z.string().default(""),
    /** Their position address at the time we mirrored, when datapi exposed it. */
    source_position: z.string().nullable().default(null),
    opened_at: z.string(),
    closed_at: z.string().nullable().default(null),
    /** Set when the close was triggered by the source wallet exiting. */
    close_reason: z.string().nullable().default(null),
    amount_sol: z.number().nullable().default(null),
    lower_bin: z.number().int().nullable().default(null),
    upper_bin: z.number().int().nullable().default(null),
    /** Their bin range as datapi reported it — kept for the retrospective. */
    source_lower_bin: z.number().int().nullable().default(null),
    source_upper_bin: z.number().int().nullable().default(null),
    source_deposit_sol: z.number().nullable().default(null),
    /** Context captured at mirror-open — the "why did they enter" evidence. */
    entry_technicals: z.array(TechnicalsSummarySchema).nullable().default(null),
    entry_context: z.record(z.string(), z.unknown()).nullable().default(null),
    /** Context captured at mirror-close — the "why did they exit" evidence. */
    exit_technicals: z.array(TechnicalsSummarySchema).nullable().default(null),
    exit_context: z.record(z.string(), z.unknown()).nullable().default(null),
    /** Their realised PnL% at the moment they exited, when datapi exposed it. */
    source_pnl_pct: z.number().nullable().default(null),
    /** Lesson id written by the retrospective, if one ran. */
    lesson_id: z.string().nullable().default(null),
  })
  .passthrough();
export type MirroredPosition = z.infer<typeof MirroredPositionSchema>;

export const FollowStateFileSchema = z.object({
  wallets: z.array(FollowedWalletSchema).default([]),
  /**
   * Last observed open-pool set per wallet. The diff engine compares this against
   * the next poll — it is the ONLY thing that distinguishes "they just opened" from
   * "they were already in". Seeded on first sight so a cold start never mass-mirrors.
   */
  seen: z.record(z.string(), z.array(z.string())).default({}),
  /** Wallets whose `seen` entry has been seeded at least once. */
  seeded: z.array(z.string()).default([]),
  mirrored: z.array(MirroredPositionSchema).default([]),
});
export type FollowStateFile = z.infer<typeof FollowStateFileSchema>;

/** Closed mirror records older than this are pruned so the file cannot grow forever. */
export const MAX_MIRRORED_RECORDS = 200 as const;

export function emptyFollowStateFile(): FollowStateFile {
  return { wallets: [], seen: {}, seeded: [], mirrored: [] };
}
