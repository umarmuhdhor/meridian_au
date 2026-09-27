import { z } from "zod";
import type { Logger } from "../../../ports/logger.js";

/** Meteora dlmm.datapi positions base — matches METEORA_PNL in tools/pnl.js. */
export const DEFAULT_METEORA_DATAPI_BASE_URL = "https://dlmm.datapi.meteora.ag/positions";

const DEFAULT_TIMEOUT_MS = 6_000;

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

/** Numeric-ish field — datapi returns numbers as strings, sometimes 0, sometimes missing. */
const NumLike = z.union([z.number(), z.string()]).transform((v) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
});

const AmountBucket = z
  .object({
    usd: NumLike.nullable().optional(),
    sol: NumLike.nullable().optional(),
    amountSol: NumLike.nullable().optional(),
  })
  .partial();

export const DatapiPositionSchema = z
  .object({
    positionAddress: z.string().optional(),
    address: z.string().optional(),
    position: z.string().optional(),
    lowerBinId: z.number().int().optional(),
    upperBinId: z.number().int().optional(),
    poolActiveBinId: z.number().int().optional(),
    isOutOfRange: z.boolean().optional(),
    pnlPctChange: NumLike.nullable().optional(),
    pnlSolPctChange: NumLike.nullable().optional(),
    allTimeDeposits: z.object({ total: AmountBucket.optional() }).partial().optional(),
    allTimeWithdrawals: z.object({ total: AmountBucket.optional() }).partial().optional(),
    allTimeFees: z.object({ total: AmountBucket.optional() }).partial().optional(),
    unrealizedPnl: z
      .object({
        balances: NumLike.nullable().optional(),
        balancesSol: NumLike.nullable().optional(),
        unclaimedFeeTokenX: AmountBucket.optional(),
        unclaimedFeeTokenY: AmountBucket.optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

const DatapiResponseSchema = z
  .object({
    positions: z.array(DatapiPositionSchema).optional(),
    data: z.array(DatapiPositionSchema).optional(),
  })
  .passthrough();

/** Normalized per-position payload the Meteora client consumes downstream. */
export interface DatapiPnlRecord {
  positionAddress: string;
  lowerBinId: number | null;
  upperBinId: number | null;
  poolActiveBinId: number | null;
  isOutOfRange: boolean | null;
  reportedPctUsd: number | null;
  reportedPctSol: number | null;
  balancesUsd: number | null;
  balancesSol: number | null;
  unclaimedFeeUsd: number;
  unclaimedFeeSol: number;
  depositUsd: number | null;
  depositSol: number | null;
  withdrawalsUsd: number;
  withdrawalsSol: number;
  feesUsd: number;
  feesSol: number;
}

type DatapiPnlFetch = (
  poolAddress: string,
  walletAddress: string,
) => Promise<Map<string, DatapiPnlRecord>>;

/**
 * Fetches the wallet's OPEN positions in a pool. `closed`, when present, fetches the
 * CLOSED ones instead — the settled deposit / withdrawal / fee totals Meteora's own
 * "All Closed Position" view renders. Optional so plain test doubles stay valid.
 */
export type MeteoraDatapiPnlFetcher = DatapiPnlFetch & { closed?: DatapiPnlFetch };

export interface MeteoraDatapiPnlOptions {
  logger: Logger;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
  timeoutMs?: number;
}

function sumNums(...vals: Array<number | null | undefined>): number {
  return vals.reduce<number>((acc, v) => acc + (typeof v === "number" && Number.isFinite(v) ? v : 0), 0);
}

/** Normalize a datapi position into the shape assessPnl consumes. */
export function normalizeDatapiPosition(raw: z.infer<typeof DatapiPositionSchema>): DatapiPnlRecord | null {
  const addr = raw.positionAddress ?? raw.address ?? raw.position;
  if (!addr) return null;
  const unr = raw.unrealizedPnl ?? {};
  const feeX = unr.unclaimedFeeTokenX ?? {};
  const feeY = unr.unclaimedFeeTokenY ?? {};
  return {
    positionAddress: addr,
    lowerBinId: raw.lowerBinId ?? null,
    upperBinId: raw.upperBinId ?? null,
    poolActiveBinId: raw.poolActiveBinId ?? null,
    isOutOfRange: raw.isOutOfRange ?? null,
    reportedPctUsd: raw.pnlPctChange ?? null,
    reportedPctSol: raw.pnlSolPctChange ?? null,
    balancesUsd: unr.balances ?? null,
    balancesSol: unr.balancesSol ?? null,
    unclaimedFeeUsd: sumNums(feeX.usd, feeY.usd),
    unclaimedFeeSol: sumNums(feeX.amountSol, feeY.amountSol),
    depositUsd: raw.allTimeDeposits?.total?.usd ?? null,
    depositSol: raw.allTimeDeposits?.total?.sol ?? null,
    withdrawalsUsd: raw.allTimeWithdrawals?.total?.usd ?? 0,
    withdrawalsSol: raw.allTimeWithdrawals?.total?.sol ?? 0,
    feesUsd: raw.allTimeFees?.total?.usd ?? 0,
    feesSol: raw.allTimeFees?.total?.sol ?? 0,
  };
}

/**
 * Pure — derive open-position PnL % from the datapi's amount buckets.
 * Mirrors `deriveOpenPnlPct` in tools/dlmm.js:1078.
 */
export function deriveOpenPnlPct(rec: DatapiPnlRecord, solMode: boolean): number | null {
  const deposit = solMode ? rec.depositSol : rec.depositUsd;
  if (deposit == null || deposit <= 0) return null;
  const balances = (solMode ? rec.balancesSol : rec.balancesUsd) ?? 0;
  const unclaimedFees = solMode ? rec.unclaimedFeeSol : rec.unclaimedFeeUsd;
  const withdrawals = solMode ? rec.withdrawalsSol : rec.withdrawalsUsd;
  const fees = solMode ? rec.feesSol : rec.feesUsd;
  return ((balances + unclaimedFees + withdrawals + fees - deposit) / deposit) * 100;
}

/**
 * Fetch per-position PnL bin data from Meteora's datapi.
 *
 * On any failure (HTTP error, network exception, malformed body) returns an empty Map —
 * the caller treats missing data as "pnl unpriceable this tick" (mirrors the JS fallback).
 * The Meteora datapi is best-effort telemetry, not a correctness gate.
 */
export function createMeteoraDatapiPnlFetcher(opts: MeteoraDatapiPnlOptions): MeteoraDatapiPnlFetcher {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  if (typeof fetchImpl !== "function") {
    throw new Error("createMeteoraDatapiPnlFetcher: no fetch implementation available");
  }
  const baseUrl = (opts.baseUrl ?? DEFAULT_METEORA_DATAPI_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function fetchByStatus(
    poolAddress: string,
    walletAddress: string,
    status: "open" | "closed",
  ): Promise<Map<string, DatapiPnlRecord>> {
    const url =
      `${baseUrl}/${poolAddress}/pnl?user=${walletAddress}` +
      `&status=${status}&pageSize=100&page=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        opts.logger.warn("meteora-datapi", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}`, {
          status: res.status,
          statusText: res.statusText,
        });
        return new Map();
      }
      const body: unknown = await res.json();
      const parsed = DatapiResponseSchema.parse(body);
      const rows = parsed.positions ?? parsed.data ?? [];
      const out = new Map<string, DatapiPnlRecord>();
      for (const raw of rows) {
        const rec = normalizeDatapiPosition(raw);
        if (rec) out.set(rec.positionAddress, rec);
      }
      return out;
    } catch (err) {
      opts.logger.warn("meteora-datapi", `fetch error for pool ${poolAddress.slice(0, 8)}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Map();
    } finally {
      clearTimeout(timer);
    }
  }

  const fetcher: MeteoraDatapiPnlFetcher = (poolAddress, walletAddress) =>
    fetchByStatus(poolAddress, walletAddress, "open");
  fetcher.closed = (poolAddress, walletAddress) => fetchByStatus(poolAddress, walletAddress, "closed");
  return fetcher;
}
