/** One open position held by a watched (foreign) wallet. */
export interface WatchedPosition {
  /** Their position address, when the source exposes it. */
  position: string | null;
  pool: string;
  pool_name: string | null;
  base_mint: string | null;
  lower_bin: number | null;
  upper_bin: number | null;
  /** Their total deposit in SOL terms, when the source exposes it. */
  deposit_sol: number | null;
  pnl_pct: number | null;
}

export interface WatchedWalletSnapshot {
  wallet: string;
  /** Distinct pool addresses the wallet currently has an open position in. */
  pools: string[];
  positions: WatchedPosition[];
  /**
   * False when the upstream call failed or timed out. The diff engine MUST treat an
   * unreliable snapshot as "no information" — never as "they closed everything".
   */
  reliable: boolean;
}

/**
 * Reads ANOTHER wallet's open DLMM positions.
 *
 * Deliberately separate from `ChainClient.getMyPositions`: that path is hard-wired to
 * the daemon's own keypair (the `wallet_address` option on GetPositionsOptions is
 * accepted but ignored by the Meteora adapter), so building follow-the-wallet on it
 * would silently mirror our own portfolio.
 */
export interface WalletWatcher {
  /** Pool-level snapshot — cheap, one request per page. Used every tick. */
  getOpenPools(wallet: string): Promise<WatchedWalletSnapshot>;
  /**
   * Position detail for one pool — bin range, deposit, PnL. Only called for pools that
   * just appeared/disappeared in the diff, so cost stays proportional to activity.
   */
  getPositionsInPool(wallet: string, pool: string): Promise<WatchedPosition[]>;
}
