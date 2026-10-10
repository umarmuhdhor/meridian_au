import { z } from "zod";
import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { KlineClient, KlineFetchOptions } from "../../ports/kline-client.js";
import type { KlineCandle, KlineTimeframe } from "../../domain/schemas/kline.js";

/**
 * GeckoTerminal OHLCV adapter.
 *
 *   GET /networks/{network}/pools/{pool_address}/ohlcv/{timeframe}?aggregate={n}&limit={l}
 *
 * Free, keyless, ~30 req/min per IP. We use it as the primary kline source for
 * Solana Meteora pools. Failures never throw — the port contract is fail-open
 * (empty array), so a rate-limit / DNS blip drops the technicals line for that
 * candidate but never blocks a screening cycle.
 *
 * Response shape (relevant subset):
 *   { data: { attributes: { ohlcv_list: [ [ts, o, h, l, c, v], … ] } } }
 *
 * Timeframe mapping — GT uses `{minute|hour|day}` + an `aggregate` count:
 *   1m  → minute, aggregate=1
 *   5m  → minute, aggregate=5
 *   15m → minute, aggregate=15
 *   1h  → hour,   aggregate=1
 *   4h  → hour,   aggregate=4
 *   1d  → day,    aggregate=1
 *
 * Cache: per (pool,timeframe) key, single-slot TTL with inflight dedup.
 */

export const DEFAULT_GT_BASE_URL = "https://api.geckoterminal.com/api/v2";
export const DEFAULT_NETWORK = "solana";
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 4_000;

// GT returns numeric OHLCV rows; each is [timestamp_sec, open, high, low, close, volume_usd].
const OhlcvRowSchema = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]);
const GtOhlcvResponseSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(OhlcvRowSchema).default([]),
    }),
  }),
});

export type FetchImpl = (input: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

export interface GeckoTerminalKlineOptions {
  clock: Clock;
  logger: Logger;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
  network?: string;
  ttlMs?: number;
  timeoutMs?: number;
}

interface CacheEntry {
  value: KlineCandle[];
  fetchedAt: number;
}

function mapTimeframe(tf: KlineTimeframe): { path: "minute" | "hour" | "day"; aggregate: number } {
  switch (tf) {
    case "1m":
      return { path: "minute", aggregate: 1 };
    case "5m":
      return { path: "minute", aggregate: 5 };
    case "15m":
      return { path: "minute", aggregate: 15 };
    case "1h":
      return { path: "hour", aggregate: 1 };
    case "4h":
      return { path: "hour", aggregate: 4 };
    case "1d":
      return { path: "day", aggregate: 1 };
  }
}

export function createGeckoTerminalKlineClient(opts: GeckoTerminalKlineOptions): KlineClient {
  const clock = opts.clock;
  const logger = opts.logger;
  const baseUrl = (opts.baseUrl ?? DEFAULT_GT_BASE_URL).replace(/\/$/, "");
  const network = opts.network ?? DEFAULT_NETWORK;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: FetchImpl =
    opts.fetchImpl ?? ((globalThis as { fetch?: FetchImpl }).fetch as FetchImpl);

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<KlineCandle[]>>();

  const isFresh = (e: CacheEntry): boolean => clock.now().getTime() - e.fetchedAt < ttlMs;

  async function fetchOnce(
    pool: string,
    tf: KlineTimeframe,
    limit: number,
    currency: "usd" | "token",
    beforeTs: number | undefined,
  ): Promise<KlineCandle[]> {
    const { path, aggregate } = mapTimeframe(tf);
    const before = beforeTs !== undefined ? `&before_timestamp=${Math.floor(beforeTs)}` : "";
    const url = `${baseUrl}/networks/${network}/pools/${pool}/ohlcv/${path}?aggregate=${aggregate}&limit=${limit}&currency=${currency}${before}`;
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        logger.warn("gt-kline", `HTTP ${res.status} ${res.statusText} ${pool} ${tf}`);
        return [];
      }
      const raw = await res.json();
      const parsed = GtOhlcvResponseSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn("gt-kline", `parse failed ${pool} ${tf}: ${parsed.error.message.slice(0, 200)}`);
        return [];
      }
      // GT returns newest-first; the technicals module expects oldest-first.
      const rows = parsed.data.data.attributes.ohlcv_list.slice().reverse();
      return rows.map(
        ([t, o, h, l, c, v]): KlineCandle => ({ t, o, h, l, c, v }),
      );
    } catch (err) {
      logger.warn("gt-kline", `fetch failed ${pool} ${tf}: ${(err as Error).message ?? String(err)}`);
      return [];
    } finally {
      clearTimeout(to);
    }
  }

  return {
    async getKline(
      poolAddress: string,
      timeframe: KlineTimeframe,
      o: KlineFetchOptions = {},
    ): Promise<KlineCandle[]> {
      const limit = Math.max(1, Math.min(1000, o.limit ?? DEFAULT_LIMIT));
      const currency = o.currency ?? "usd";
      const key = `${poolAddress}|${timeframe}|${limit}|${currency}|${o.beforeTs ?? ""}`;
      if (!o.force) {
        const hit = cache.get(key);
        if (hit && isFresh(hit)) return hit.value;
        const pending = inflight.get(key);
        if (pending) return pending;
      }
      const p = fetchOnce(poolAddress, timeframe, limit, currency, o.beforeTs).then((value) => {
        cache.set(key, { value, fetchedAt: clock.now().getTime() });
        inflight.delete(key);
        return value;
      }).catch((e) => {
        inflight.delete(key);
        throw e;
      });
      inflight.set(key, p);
      return p;
    },
  };
}
