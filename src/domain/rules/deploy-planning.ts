import { MIN_SAFE_BINS_BELOW } from "../schemas/config.js";

export type LpStrategy = "spot" | "curve" | "bid_ask";

/** Threshold above which the Meteora SDK requires the wide-range multi-tx path. */
export const WIDE_RANGE_THRESHOLD = 69;

export interface DeployPlanInput {
  poolAddress: string;
  activeBinId: number;
  binStep: number;
  activePrice: number;
  strategy: LpStrategy;
  binsBelow: number;
  binsAbove: number;
  amountY: number;
  amountX?: number;
  minBinsBelow?: number;
  /**
   * Waives the MIN_SAFE_BINS_BELOW floor. Set ONLY by the follow-the-wallet path,
   * where the range is copied from a wallet the user chose to trust rather than
   * chosen by the screener. Every other caller leaves this unset and keeps the floor.
   */
  allowTinyRange?: boolean;
}

export interface DeployPlan {
  poolAddress: string;
  strategy: LpStrategy;
  minBinId: number;
  maxBinId: number;
  totalBins: number;
  isWideRange: boolean;
  isSingleSidedSol: boolean;
  amountX: number;
  amountY: number;
  downsideCoveragePct: number | null;
  upsideCoveragePct: number | null;
  totalWidthPct: number | null;
}

/** Bin price = (1 + binStep / 10_000) ^ binId. Matches Meteora `getPriceOfBinByBinId`. */
export function priceOfBin(binId: number, binStep: number): number {
  if (!Number.isFinite(binId) || !Number.isFinite(binStep) || binStep <= 0) return 0;
  return Math.pow(1 + binStep / 10_000, binId);
}

/**
 * Pure — decide the exact bin range, side layout, and wide-range path for a deploy.
 *
 * Mirrors the validation cascade in tools/dlmm.js:540-616 without any SDK / chain / RPC
 * dependency. Every branch here throws a typed message the caller can log verbatim, so
 * the write path (when it lands) can rely on the plan being pre-validated: bin math
 * bounded, strategy legal, single-side rules enforced, safety floor honored.
 *
 * Not covered here (still lives at the write-side):
 *   - Bin-array initialization rent check (RPC lookup).
 *   - Pool freshness / TVL revalidation.
 *   - Slippage protection during add-liquidity.
 */
export function planDeploy(input: DeployPlanInput): DeployPlan {
  const {
    poolAddress,
    activeBinId,
    binStep,
    activePrice,
    strategy,
    amountY,
    amountX = 0,
  } = input;
  let binsBelow = input.binsBelow;
  let binsAbove = input.binsAbove;
  const minBinsBelow = input.allowTinyRange
    ? Math.max(1, input.minBinsBelow ?? 1)
    : Math.max(MIN_SAFE_BINS_BELOW, input.minBinsBelow ?? MIN_SAFE_BINS_BELOW);

  if (!Number.isFinite(amountY) || !Number.isFinite(amountX) || amountY < 0 || amountX < 0) {
    throw new Error("planDeploy: amountY and amountX must be finite non-negative numbers");
  }
  if (amountX > 0) {
    throw new Error(
      "planDeploy: only single-side SOL (amountY) deploys are supported — amountX must be 0",
    );
  }
  if (amountY <= 0) {
    throw new Error("planDeploy: amountY must be positive");
  }
  const isSingleSidedSol = amountX <= 0 && amountY > 0;
  if (isSingleSidedSol && binsAbove > 0) {
    throw new Error(
      "planDeploy: single-side SOL deploy cannot have bins_above > 0 (upper bin is the SDK active bin)",
    );
  }
  if (isSingleSidedSol) binsAbove = 0;

  if (!Number.isInteger(binsBelow) || !Number.isInteger(binsAbove)) {
    throw new Error("planDeploy: bins_below and bins_above must be whole integers");
  }
  if (binsBelow < 0 || binsAbove < 0) {
    throw new Error("planDeploy: bins_below and bins_above cannot be negative");
  }

  const totalBins = binsBelow + binsAbove;
  if (totalBins < minBinsBelow) {
    throw new Error(
      `planDeploy: total bins ${totalBins} below safety floor ${minBinsBelow} — refuse tiny-range deploy`,
    );
  }

  if (!Number.isInteger(activeBinId)) {
    throw new Error("planDeploy: activeBinId must be an integer");
  }
  if (!Number.isFinite(binStep) || binStep <= 0) {
    throw new Error("planDeploy: binStep must be a positive number");
  }

  const minBinId = activeBinId - binsBelow;
  const maxBinId = isSingleSidedSol ? activeBinId : activeBinId + binsAbove;
  if (minBinId > maxBinId) {
    throw new Error(`planDeploy: invalid bin range ${minBinId} → ${maxBinId}`);
  }
  if (isSingleSidedSol && maxBinId !== activeBinId) {
    throw new Error(
      `planDeploy: single-side SOL deploy must end at the active bin (expected ${activeBinId}, got ${maxBinId})`,
    );
  }

  const isWideRange = totalBins > WIDE_RANGE_THRESHOLD;

  const minPrice = priceOfBin(minBinId, binStep);
  const maxPrice = priceOfBin(maxBinId, binStep);
  const downsideCoveragePct =
    activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
  const upsideCoveragePct =
    activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
  const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;

  return {
    poolAddress,
    strategy,
    minBinId,
    maxBinId,
    totalBins,
    isWideRange,
    isSingleSidedSol,
    amountX,
    amountY,
    downsideCoveragePct,
    upsideCoveragePct,
    totalWidthPct,
  };
}
