import type {
  ActiveBin,
  ClaimResult,
  ClosedPositionPnl,
  CloseResult,
  DeployArgs,
  DeployResult,
  PositionsSnapshot,
  WalletBalance,
  WalletToken,
} from "../domain/schemas/chain.js";

export interface GetPositionsOptions {
  /** Bypass the cache — used by deploy safety check for a fresh count. */
  force?: boolean;
  /** Suppress per-position logs when true — used by cron/shutdown paths. */
  silent?: boolean;
  wallet_address?: string;
}

/**
 * The on-chain surface. Every write path returns a discriminated result with a `success`
 * flag rather than throwing — the ReAct loop needs the failure signal in-band. Read paths
 * throw only on unrecoverable RPC errors (network dead, key missing).
 */
export interface ChainClient {
  getWalletBalance(walletAddress?: string): Promise<WalletBalance>;
  /**
   * Optional: list SPL token holdings (mint, balance, USD). Adapters without a token
   * source (e.g. dry-run) may omit it — callers must treat it as possibly undefined.
   */
  getWalletTokens?(walletAddress?: string): Promise<WalletToken[]>;
  getActiveBin(poolAddress: string): Promise<ActiveBin>;
  getMyPositions(opts?: GetPositionsOptions): Promise<PositionsSnapshot>;
  deployPosition(args: DeployArgs): Promise<DeployResult>;
  closePosition(positionAddress: string, reason: string): Promise<CloseResult>;
  claimFees(positionAddress: string): Promise<ClaimResult>;
  /**
   * Optional: settled PnL totals for one of OUR closed positions. Resolves `null` when
   * the position is not (yet) in the source's closed set, or the read failed — both
   * mean "ask again later", never "zero". Adapters without a closed-PnL source omit it.
   */
  getClosedPositionPnl?(poolAddress: string, positionAddress: string): Promise<ClosedPositionPnl | null>;
}
