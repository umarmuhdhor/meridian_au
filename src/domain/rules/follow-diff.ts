import type { MirroredPosition } from "../schemas/follow-wallet.js";
import type { WatchedWalletSnapshot } from "../../ports/wallet-watcher.js";

export interface FollowDiffInput {
  /** Pools observed on the previous tick, or null when this wallet has never been seen. */
  seen: string[] | null;
  snapshot: WatchedWalletSnapshot;
  /** Pools OUR wallet currently has an open position in, from any source. */
  ourOpenPools: readonly string[];
  /** Our open mirror records for THIS wallet. */
  openMirrors: readonly MirroredPosition[];
}

export interface FollowSkip {
  pool: string;
  reason: "already_open" | "already_mirrored";
}

export interface FollowDiffResult {
  /**
   * True on the first sight of a wallet: the baseline is recorded and NOTHING is
   * mirrored. Without this a newly added wallet would mass-mirror every position it
   * already holds — positions whose entry we missed and whose thesis we cannot infer.
   */
  seedOnly: boolean;
  /** Pools the wallet just entered and we should mirror. */
  opens: string[];
  /** Our mirror records whose source position has disappeared. */
  closes: MirroredPosition[];
  skipped: FollowSkip[];
  /** Baseline to persist for the next tick, or null when the tick was too degraded. */
  nextSeen: string[] | null;
  /**
   * Set when close detection was suppressed because the snapshot was incomplete.
   * Surfaced so the caller can log it rather than silently doing nothing.
   */
  closesSuppressed: boolean;
}

/**
 * Pure diff between the previous and current open-pool set of a followed wallet.
 *
 * Two asymmetries carry the safety of this feature:
 *
 *   1. First sight seeds, never mirrors. A cold start, a re-enable, and a re-add all
 *      route through the same path, so none of them replay history.
 *   2. An unreliable snapshot (datapi error mid-pagination) suppresses CLOSES but still
 *      allows OPENS. A truncated page list can hide a pool that is still open — reading
 *      that as an exit would close every mirrored position on a transient 502. It cannot
 *      invent a pool that is not there, so a newly seen pool is always a genuine entry.
 */
export function diffFollowedWallet(input: FollowDiffInput): FollowDiffResult {
  const { seen, snapshot, ourOpenPools, openMirrors } = input;
  const current = snapshot.pools;

  if (seen == null) {
    return {
      seedOnly: true,
      opens: [],
      closes: [],
      skipped: [],
      // Seed from a degraded snapshot too: a partial baseline only risks a later
      // duplicate "open" signal, which the already_open / already_mirrored guards
      // below absorb. Refusing to seed would leave the wallet permanently unseeded.
      nextSeen: current,
      closesSuppressed: false,
    };
  }

  const seenSet = new Set(seen);
  const currentSet = new Set(current);
  const mirroredPools = new Set(openMirrors.map((m) => m.pool));
  const ourPools = new Set(ourOpenPools);

  const opens: string[] = [];
  const skipped: FollowSkip[] = [];
  for (const pool of current) {
    if (seenSet.has(pool)) continue;
    if (mirroredPools.has(pool)) {
      skipped.push({ pool, reason: "already_mirrored" });
      continue;
    }
    if (ourPools.has(pool)) {
      // Screening already put us in this pool. Mirroring would double the exposure
      // and leave two positions racing the same exit signal.
      skipped.push({ pool, reason: "already_open" });
      continue;
    }
    opens.push(pool);
  }

  const closesSuppressed = !snapshot.reliable;
  const closes = closesSuppressed
    ? []
    : openMirrors.filter((m) => !currentSet.has(m.pool));

  return {
    seedOnly: false,
    opens,
    closes,
    skipped,
    // A degraded snapshot must not become the baseline — a pool missing from a
    // truncated page list would be remembered as "never open", and the wallet's
    // real exit from it would then never register as a close.
    nextSeen: snapshot.reliable ? current : null,
    closesSuppressed,
  };
}

export interface MirrorSizeInput {
  /** Free SOL in our wallet right now. */
  walletSol: number;
  /** Fraction of free SOL to commit per mirrored open (0 < pct <= 1). */
  sizePct: number;
  gasReserve: number;
  minDeploySol: number;
  maxDeploySol: number;
}

export type MirrorSizeResult =
  | { ok: true; amountSol: number }
  | { ok: false; reason: string };

/**
 * Proportional sizing: commit `sizePct` of the SOL that is free AFTER the gas reserve,
 * then clamp to [minDeploySol, maxDeploySol]. Returns a reason instead of a number when
 * the wallet cannot fund even the minimum — the caller logs it and skips, it is not an
 * error condition.
 */
export function planMirrorSize(input: MirrorSizeInput): MirrorSizeResult {
  const { walletSol, sizePct, gasReserve, minDeploySol, maxDeploySol } = input;
  if (!Number.isFinite(walletSol) || walletSol <= 0) {
    return { ok: false, reason: "wallet balance unavailable or zero" };
  }
  const deployable = walletSol - gasReserve;
  if (deployable <= 0) {
    return {
      ok: false,
      reason: `wallet ${walletSol.toFixed(4)} SOL is at or below gasReserve ${gasReserve}`,
    };
  }
  const raw = deployable * sizePct;
  const clamped = Math.min(maxDeploySol, Math.max(0, raw));
  if (clamped < minDeploySol) {
    return {
      ok: false,
      reason: `sized ${clamped.toFixed(4)} SOL (${(sizePct * 100).toFixed(0)}% of ${deployable.toFixed(4)} free) below minimum ${minDeploySol}`,
    };
  }
  // Round to 4dp so the deploy amount is readable in logs and Telegram cards.
  return { ok: true, amountSol: Math.floor(clamped * 10_000) / 10_000 };
}

export interface MirrorRangeInput {
  /** The pool's active bin right now. */
  activeBin: number;
  /** Their position's lower bin, when datapi reported it. */
  sourceLowerBin: number | null;
  /** Fallback width when their range is unknown. */
  fallbackBinsBelow: number;
  /** Hard ceiling on how wide a mirrored range may be. */
  maxBinsBelow: number;
  /** Hard floor — a range narrower than this is widened, not rejected. */
  minBinsBelow: number;
}

export interface MirrorRangeResult {
  binsBelow: number;
  /** How the width was derived — logged so a surprising range is explainable. */
  source: "mirrored" | "fallback";
  /** Set when the mirrored width had to be clamped to the configured bounds. */
  clampedFrom: number | null;
}

/**
 * Translate their absolute bin range into OUR relative one.
 *
 * Exact mirroring is not achievable: `planDeploy` only supports single-side SOL, which
 * forces the upper bound to the active bin and the position to extend downward. What is
 * mirrorable is the DEPTH below the active bin, so that is what this reproduces —
 * `activeBin - sourceLowerBin` — clamped to the configured bounds.
 */
export function planMirrorRange(input: MirrorRangeInput): MirrorRangeResult {
  const { activeBin, sourceLowerBin, fallbackBinsBelow, maxBinsBelow, minBinsBelow } = input;
  const lo = Math.max(1, Math.min(minBinsBelow, maxBinsBelow));
  const hi = Math.max(lo, maxBinsBelow);

  if (sourceLowerBin == null || !Number.isInteger(sourceLowerBin)) {
    return {
      binsBelow: Math.min(hi, Math.max(lo, fallbackBinsBelow)),
      source: "fallback",
      clampedFrom: null,
    };
  }

  const width = activeBin - sourceLowerBin;
  if (!Number.isFinite(width) || width <= 0) {
    // Their whole range sits at or above the active bin — nothing to mirror on the
    // SOL side, so fall back rather than emit a zero-width range planDeploy rejects.
    return {
      binsBelow: Math.min(hi, Math.max(lo, fallbackBinsBelow)),
      source: "fallback",
      clampedFrom: null,
    };
  }

  const clamped = Math.min(hi, Math.max(lo, width));
  return {
    binsBelow: clamped,
    source: "mirrored",
    clampedFrom: clamped === width ? null : width,
  };
}

export interface RecenterInput {
  /** Their position address at the time we mirrored, when datapi exposed it. */
  recordedSourcePosition: string | null;
  /** Their lower bin at the time we mirrored. */
  recordedSourceLowerBin: number | null;
  /** What they hold in that pool right now. */
  current: readonly {
    position: string | null;
    lower_bin: number | null;
  }[];
  /** Bin drift below which a range change is treated as noise. */
  thresholdBins: number;
}

export type RecenterVerdict =
  | { recentered: false; reason: null }
  | { recentered: true; reason: string };

/**
 * Did the followed wallet re-center inside a pool it is still in?
 *
 * A pool-membership diff cannot see this: they close and reopen in the SAME pool, so the
 * pool never leaves their set and no open/close signal fires. Meanwhile our mirror keeps
 * the old range — and under `follow.exclusiveExit` the out-of-range rule that used to
 * clean this up has been switched off, so the position can sit outside the active range
 * earning nothing until they abandon the pool entirely.
 *
 * Two independent signals, either sufficient:
 *   - the specific position we copied is no longer in their list (unambiguous: that
 *     position was closed), or
 *   - their lower bin has moved by more than `thresholdBins`.
 *
 * The threshold exists because `current` may hold several positions and the "widest"
 * pick can flip between polls; a bin or two of churn is not a re-center. Missing data
 * on either side yields `false` — fail-quiet, since the cost of a false positive here
 * is a needless close-and-reopen with real fees.
 */
export function detectRecenter(input: RecenterInput): RecenterVerdict {
  const { recordedSourcePosition, recordedSourceLowerBin, current, thresholdBins } = input;
  if (current.length === 0) {
    // They hold nothing in this pool. That is an EXIT, which the pool-set diff owns —
    // reporting it as a re-center here would double-handle it.
    return { recentered: false, reason: null };
  }

  if (recordedSourcePosition != null) {
    const stillThere = current.some((p) => p.position === recordedSourcePosition);
    if (!stillThere) {
      return {
        recentered: true,
        reason: `their position ${recordedSourcePosition.slice(0, 8)}… is gone while they remain in the pool`,
      };
    }
    // The copied position is still open — whatever else they hold is an addition,
    // not a re-center of the range we are mirroring.
    return { recentered: false, reason: null };
  }

  if (recordedSourceLowerBin == null) return { recentered: false, reason: null };
  const lowerBins = current.map((p) => p.lower_bin).filter((b): b is number => b != null);
  if (lowerBins.length === 0) return { recentered: false, reason: null };

  // Closest current position to what we copied — if ANY of their positions still sits
  // near the old range, they have not moved off it.
  const drift = Math.min(...lowerBins.map((b) => Math.abs(b - recordedSourceLowerBin)));
  if (drift > thresholdBins) {
    return {
      recentered: true,
      reason: `their lower bin moved ${drift} bins from ${recordedSourceLowerBin} (threshold ${thresholdBins})`,
    };
  }
  return { recentered: false, reason: null };
}

export interface MirrorCapacityInput {
  /** Open positions we hold right now, from every source. */
  ourOpenCount: number;
  maxPositions: number;
  /** Open mirrors we hold right now. */
  openMirrorCount: number;
  /** Cap on concurrent mirrors, so follow cannot consume the whole portfolio. */
  maxMirrored: number;
}

export interface MirrorCapacity {
  slots: number;
  /** Set when slots is 0 — which limit bit, for the log. */
  blockedBy: "max_positions" | "max_mirrored" | null;
}

/**
 * How many new mirrors may be opened this tick.
 *
 * Follow positions have no local exit under `follow.exclusiveExit`, so without a cap of
 * their own they can hold every `maxPositions` slot indefinitely and silently starve
 * screening — which would just keep logging "at max positions" with no hint that follow
 * is the reason. `maxMirrored` reserves the remainder for the screener.
 */
export function mirrorCapacity(input: MirrorCapacityInput): MirrorCapacity {
  const { ourOpenCount, maxPositions, openMirrorCount, maxMirrored } = input;
  const portfolioSlots = Math.max(0, maxPositions - ourOpenCount);
  const mirrorSlots = Math.max(0, maxMirrored - openMirrorCount);
  const slots = Math.min(portfolioSlots, mirrorSlots);
  if (slots > 0) return { slots, blockedBy: null };
  return { slots: 0, blockedBy: mirrorSlots <= 0 ? "max_mirrored" : "max_positions" };
}

export type MirrorOrphanCause = "follow_disabled" | "wallet_disabled" | "wallet_removed";

export interface OrphanedMirror {
  mirror: MirroredPosition;
  cause: MirrorOrphanCause;
}

export interface MirrorOwnershipInput {
  /** The global `follow.enabled` switch. */
  followEnabled: boolean;
  /** Every followed wallet on record, enabled or not. */
  wallets: readonly { address: string; enabled: boolean }[];
  openMirrors: readonly MirroredPosition[];
}

export interface MirrorOwnership {
  /** Mirrors whose source wallet is still actively polled — that wallet owns the exit. */
  owned: MirroredPosition[];
  /** Mirrors with no source left to follow, and why. */
  orphaned: OrphanedMirror[];
}

/**
 * Who, right now, is entitled to decide when each open mirror closes?
 *
 * `follow.exclusiveExit` hands a mirrored position's exit to the wallet it was copied
 * from and switches off every local rule for it. That trade is only sound while such a
 * wallet actually exists and is being polled. The moment it stops being followed —
 * the master switch goes off, the wallet is disabled, or it is removed outright — the
 * follow cycle will never close that position, and if the exemption still stood nothing
 * else would either. The position would answer to nobody.
 *
 * So ownership is computed from the SAME conditions the follow cycle uses to decide
 * whether it will act on a wallet. Anything outside that set is orphaned, and the caller
 * is responsible for it: the cycle drains orphans by closing them, while management and
 * the poller re-arm their local rules over them in the meantime.
 */
export function partitionMirrorOwnership(input: MirrorOwnershipInput): MirrorOwnership {
  const { followEnabled, wallets, openMirrors } = input;
  const known = new Map(wallets.map((w) => [w.address, w.enabled]));

  const owned: MirroredPosition[] = [];
  const orphaned: OrphanedMirror[] = [];

  for (const mirror of openMirrors) {
    const walletEnabled = known.get(mirror.source_wallet);
    let cause: MirrorOrphanCause | null = null;
    // Order matters only for the message: the master switch is reported first because
    // it explains every mirror at once, which is what the operator needs to read.
    if (!followEnabled) cause = "follow_disabled";
    else if (walletEnabled === undefined) cause = "wallet_removed";
    else if (!walletEnabled) cause = "wallet_disabled";

    if (cause == null) owned.push(mirror);
    else orphaned.push({ mirror, cause });
  }

  return { owned, orphaned };
}

/** One line explaining an orphan, used in the close reason and the operator alert. */
export function describeOrphanCause(cause: MirrorOrphanCause): string {
  switch (cause) {
    case "follow_disabled":
      return "follow.enabled was turned off";
    case "wallet_disabled":
      return "the followed wallet was disabled";
    case "wallet_removed":
      return "the followed wallet was removed";
  }
}
