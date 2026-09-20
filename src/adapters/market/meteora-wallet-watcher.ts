import { z } from "zod";
import type { Logger } from "../../ports/logger.js";
import type {
  WalletWatcher,
  WatchedPosition,
  WatchedWalletSnapshot,
} from "../../ports/wallet-watcher.js";

export const DEFAULT_DATAPI_BASE_URL = "https://dlmm.datapi.meteora.ag";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_PAGES = 10;
const PAGE_SIZE = 50;

export type FetchImpl = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** datapi returns numbers as numbers or strings depending on the field. */
const NumLike = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((v) => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  });

const PortfolioPoolSchema = z
  .object({
    poolAddress: z.string(),
    poolName: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    tokenXMint: z.string().nullable().optional(),
    baseMint: z.string().nullable().optional(),
  })
  .passthrough();

const PortfolioResponseSchema = z
  .object({
    pools: z.array(PortfolioPoolSchema).default([]),
    hasNext: z.boolean().optional(),
  })
  .passthrough();

const AmountBucket = z
  .object({ sol: NumLike, amountSol: NumLike, usd: NumLike })
  .partial()
  .passthrough();

const PnlPositionSchema = z
  .object({
    positionAddress: z.string().optional(),
    address: z.string().optional(),
    position: z.string().optional(),
    lowerBinId: z.number().int().nullable().optional(),
    upperBinId: z.number().int().nullable().optional(),
    pnlPctChange: NumLike,
    pnlSolPctChange: NumLike,
    allTimeDeposits: z.object({ total: AmountBucket.optional() }).partial().passthrough().optional(),
  })
  .passthrough();

const PnlResponseSchema = z
  .object({
    positions: z.array(PnlPositionSchema).optional(),
    data: z.array(PnlPositionSchema).optional(),
  })
  .passthrough();

export interface MeteoraWalletWatcherOptions {
  logger: Logger;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * `WalletWatcher` over Meteora's public datapi. No RPC, no DLMM SDK, no signer — it
 * reads any wallet's open positions the same way the Meteora UI does:
 *
 *   GET /portfolio/open?user=<wallet>            → which pools they are in
 *   GET /positions/<pool>/pnl?user=<wallet>      → bin range, deposit, PnL in one pool
 *
 * Fail-CLOSED on the snapshot: any HTTP/parse/timeout failure returns
 * `reliable: false` with whatever was collected. Callers must not interpret that as an
 * exit — a datapi blip would otherwise close every mirrored position at once.
 */
export function createMeteoraWalletWatcher(opts: MeteoraWalletWatcherOptions): WalletWatcher {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  if (typeof fetchImpl !== "function") {
    throw new Error("createMeteoraWalletWatcher: no fetch implementation available");
  }
  const baseUrl = (opts.baseUrl ?? DEFAULT_DATAPI_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function getJson(url: string): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        opts.logger.warn("follow-watch", `datapi ${res.status} ${res.statusText}`, { url });
        return null;
      }
      return await res.json();
    } catch (e) {
      opts.logger.warn("follow-watch", "datapi request failed", {
        url,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function normalizePosition(
    pool: string,
    poolName: string | null,
    baseMint: string | null,
    raw: z.infer<typeof PnlPositionSchema>,
  ): WatchedPosition {
    const deposits = raw.allTimeDeposits?.total;
    return {
      position: raw.positionAddress ?? raw.address ?? raw.position ?? null,
      pool,
      pool_name: poolName,
      base_mint: baseMint,
      lower_bin: raw.lowerBinId ?? null,
      upper_bin: raw.upperBinId ?? null,
      deposit_sol: deposits?.sol ?? deposits?.amountSol ?? null,
      pnl_pct: raw.pnlSolPctChange ?? raw.pnlPctChange ?? null,
    };
  }

  return {
    async getOpenPools(wallet: string): Promise<WatchedWalletSnapshot> {
      const pools: string[] = [];
      const positions: WatchedPosition[] = [];
      let reliable = true;

      for (let page = 1; page <= MAX_PAGES; page++) {
        const url =
          `${baseUrl}/portfolio/open?user=${encodeURIComponent(wallet)}` +
          `&page=${page}&pageSize=${PAGE_SIZE}`;
        const body = await getJson(url);
        if (body == null) {
          reliable = false;
          break;
        }
        const parsed = PortfolioResponseSchema.safeParse(body);
        if (!parsed.success) {
          opts.logger.warn("follow-watch", "portfolio body did not match schema", { wallet });
          reliable = false;
          break;
        }
        for (const p of parsed.data.pools) {
          if (pools.includes(p.poolAddress)) continue;
          pools.push(p.poolAddress);
          positions.push({
            position: null,
            pool: p.poolAddress,
            pool_name: p.poolName ?? p.name ?? null,
            base_mint: p.baseMint ?? p.tokenXMint ?? null,
            lower_bin: null,
            upper_bin: null,
            deposit_sol: null,
            pnl_pct: null,
          });
        }
        if (parsed.data.hasNext !== true) break;
      }

      return { wallet, pools, positions, reliable };
    },

    async getPositionsInPool(wallet: string, pool: string): Promise<WatchedPosition[]> {
      const url =
        `${baseUrl}/positions/${encodeURIComponent(pool)}/pnl` +
        `?user=${encodeURIComponent(wallet)}&status=open&page=1&pageSize=100`;
      const body = await getJson(url);
      if (body == null) return [];
      const parsed = PnlResponseSchema.safeParse(body);
      if (!parsed.success) return [];
      const rows = parsed.data.positions ?? parsed.data.data ?? [];
      return rows.map((r) => normalizePosition(pool, null, null, r));
    },
  };
}
