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
