import type { KlineCandle, KlineTimeframe } from "../domain/schemas/kline.js";

export interface KlineFetchOptions {
  /** Max candles requested. Adapters may return fewer if the source has less history. */
  limit?: number;
  /** Bypass any adapter-side cache. */
  force?: boolean;
  /**
   * Price denomination: `usd` (default) or `token` = in the pool's quote token (SOL for
   * our pools). Bin math needs `token` — USD candles carry SOL's own move.
   */
  currency?: "usd" | "token";
  /** Only candles strictly before this unix-seconds time (history replay). */
  beforeTs?: number;
}

/**
 * OHLCV source for a single Meteora pool. Adapters MUST NOT throw for a missing pool
 * or a rate-limit — resolve with an empty array so callers can fail open (screening
 * enrichment mirrors the diligence fail-open pattern).
 */
export interface KlineClient {
  getKline(
    poolAddress: string,
    timeframe: KlineTimeframe,
    opts?: KlineFetchOptions,
  ): Promise<KlineCandle[]>;
}
