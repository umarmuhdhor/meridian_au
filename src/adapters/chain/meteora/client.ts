import type { Clock } from "../../../ports/clock.js";
import type { Logger } from "../../../ports/logger.js";
import type { PriceOracle } from "../../../ports/price-oracle.js";
import type { ChainClient, GetPositionsOptions } from "../../../ports/chain-client.js";
import type { SolanaConnection, WalletKeypair } from "../../../ports/solana.js";
import type {
  ActiveBin,
  ClaimResult,
  ClosedPositionPnl,
  CloseResult,
  DeployArgs,
  DeployResult,
  OnChainPosition,
  PositionsSnapshot,
  WalletBalance,
  WalletToken,
} from "../../../domain/schemas/chain.js";
import { createTtlCache } from "../../../shared/cache.js";
import { assessPnl, roundNum } from "../../../domain/rules/pnl.js";

const JUPITER_PRICE_BASE_URL = "https://lite-api.jup.ag/price/v3";

/** Best-effort batch USD price lookup keyed by mint (empty map on any failure). */
async function fetchJupiterPrices(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {};
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") return {};
  const url = `${JUPITER_PRICE_BASE_URL}?ids=${encodeURIComponent(mints.join(","))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return {};
    // Jupiter Price v3: flat mint→{usdPrice} map (no `data` wrapper).
    const body = (await res.json()) as Record<string, { usdPrice?: number | string }>;
    const out: Record<string, number> = {};
    for (const [mint, v] of Object.entries(body ?? {})) {
      const n = typeof v.usdPrice === "number" ? v.usdPrice : Number(v.usdPrice);
      if (Number.isFinite(n)) out[mint] = n;
    }
    return out;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
import { lamportsToSol } from "./connection.js";
import type { MeteoraDatapiPnlFetcher, DatapiPnlRecord } from "./datapi-pnl.js";
import { deriveOpenPnlPct } from "./datapi-pnl.js";
import type {
  MeteoraWriteHelpers,
  NewPositionKeypair,
  SdkLoader,
  SendTx,
} from "./write-paths.js";
import {
  claimFeesForPosition,
  closePositionAt,
  createMeteoraWriteHelpers,
} from "./write-paths.js";

export interface MeteoraChainClientOptions {
  connection: SolanaConnection;
  wallet: WalletKeypair;
  price: PriceOracle;
  clock: Clock;
  logger: Logger;
  /** Positions TTL — matches tools/dlmm.js:_positionsCache default. */
  positionsTtlMs?: number;
  /**
   * Optional Meteora datapi PnL enricher. When present, positions get real
   * `pnl_pct` + `unclaimed_fees_usd` + `total_value_usd`; when absent, those
   * fields stay null and `pnl_pct_suspicious` stays true (pre-Phase 10 shape).
   */
  pnl?: MeteoraDatapiPnlFetcher;
  /**
   * Optional base-mint → token symbol resolver (e.g. token-info client). When
   * present, positions show `Wukong/SOL` instead of the mint prefix `F4Tn/SOL`.
   * Best-effort + cached; falls back to the mint prefix on null/failure.
   */
  symbolResolver?: (mint: string) => Promise<string | null>;
  /**
   * Sanity gap between reported vs derived PnL % — informational only, mirrors
   * `config.management.pnlSanityMaxDiffPct` in tools/dlmm.js.
   */
  pnlMaxDiffPct?: number;
  /**
   * SOL mode — read reported/derived PnL from the SOL-denominated fields.
   * Mirrors `config.management.solMode`.
   */
  solMode?: boolean;
  /**
   * When true, deploy/close/claim run the real Meteora SDK write path (Phase 15B).
   * When false (default), the write methods throw `MeteoraWritePathNotPortedError` —
   * matches the Phase 9 stub. The daemon flips this only when `MERIDIAN_WRITE_UNSAFE=true`.
   */
  writesEnabled?: boolean;
  /** Test hooks — real callers omit these; the client falls back to real SDK + web3.js. */
  sdkLoader?: SdkLoader;
  sendTx?: SendTx;
  newPositionKeypair?: NewPositionKeypair;
}

const DEFAULT_POSITIONS_TTL_MS = 5 * 60_000;
const DEFAULT_PNL_MAX_DIFF_PCT = 5;

/** Not-yet-ported write paths throw this — daemon boot fails loud if wired without stubs. */
export class MeteoraWritePathNotPortedError extends Error {
  constructor(op: string) {
    super(
      `MeteoraChainClient.${op} not ported yet — write paths land in the next phase. ` +
        `Use MERIDIAN_CHAIN=dryrun until then.`,
    );
    this.name = "MeteoraWritePathNotPortedError";
  }
}

interface SdkNamespace {
  default?: unknown;
  getActiveBin?: (poolAddress: unknown, connection: unknown) => Promise<{ binId: number; price: string; pricePerLamport: string }>;
}

async function loadDlmmSdk(): Promise<SdkNamespace> {
  // Lazy import matches tools/dlmm.js:33 — the CJS package explodes on eager import from ESM.
  // See DESIGN doc §11 "Known issues" + CLAUDE.md "Lazy SDK load".
  return (await import("@meteora-ag/dlmm")) as unknown as SdkNamespace;
}

/**
 * Meteora DLMM chain client — READ paths only in this phase.
 *
 *   ✓ getWalletBalance — Solana RPC + price oracle
 *   ✓ getActiveBin      — SDK
 *   ✓ getMyPositions    — SDK positions + TTL cache + inflight dedup (reused from shared/cache)
 *   ✗ deployPosition    — throws `MeteoraWritePathNotPortedError`
 *   ✗ closePosition     — throws
 *   ✗ claimFees         — throws
 *
 * Write paths must be ported deliberately in a follow-up phase — the on-chain path is
 * where real money moves. Behavioral parity vs the current JS impl requires an
 * environment with a real (or forked) Solana state to test against.
 */
export function createMeteoraChainClient(opts: MeteoraChainClientOptions): ChainClient {
  const { connection, wallet, price, clock, logger } = opts;
  const solMode = opts.solMode ?? false;
  const pnlMaxDiffPct = opts.pnlMaxDiffPct ?? DEFAULT_PNL_MAX_DIFF_PCT;

  const positionsCache = createTtlCache<PositionsSnapshot>({
    ttlMs: opts.positionsTtlMs ?? DEFAULT_POSITIONS_TTL_MS,
    clock,
  });
  const positionToPool = new Map<string, string>();
  // mint → symbol cache (symbols are stable; resolve once). null = resolved-but-unknown.
  const symbolCache = new Map<string, string | null>();
  async function resolveSymbol(mint: string | null): Promise<string | null> {
    if (!mint || !opts.symbolResolver) return null;
    if (symbolCache.has(mint)) return symbolCache.get(mint) ?? null;
    let sym: string | null = null;
    try {
      sym = await opts.symbolResolver(mint);
    } catch {
      sym = null;
    }
    symbolCache.set(mint, sym);
    return sym;
  }

  const defaultSdkLoader: SdkLoader = async () =>
    (await import("@meteora-ag/dlmm")) as unknown as import("./write-paths.js").SdkNamespace;
  const defaultSendTx: SendTx = async (tx, signers) => {
    const web3 = await import("@solana/web3.js");
    return web3.sendAndConfirmTransaction(
      connection.raw as InstanceType<typeof web3.Connection>,
      tx as InstanceType<typeof web3.Transaction>,
      signers as InstanceType<typeof web3.Keypair>[],
      { commitment: "confirmed" },
    );
  };
  const defaultNewPositionKeypair: NewPositionKeypair = async () => {
    const web3 = await import("@solana/web3.js");
    const kp = web3.Keypair.generate();
    return { publicKey: kp.publicKey, address: kp.publicKey.toBase58(), raw: kp };
  };

  let writeHelpers: MeteoraWriteHelpers | null = null;
  if (opts.writesEnabled) {
    writeHelpers = createMeteoraWriteHelpers({
      connection,
      wallet,
      clock,
      logger,
      sdkLoader: opts.sdkLoader ?? defaultSdkLoader,
      sendTx: opts.sendTx ?? defaultSendTx,
      newPositionKeypair: opts.newPositionKeypair ?? defaultNewPositionKeypair,
      onWriteCommitted: () => positionsCache.invalidate(),
    });
    logger.warn("meteora", "WRITE PATHS ARMED — MERIDIAN_WRITE_UNSAFE=true");
  }

  function assertWritable(op: string): MeteoraWriteHelpers {
    if (!writeHelpers) {
      logger.error("meteora", `${op} called before write path is armed`);
      throw new MeteoraWritePathNotPortedError(op);
    }
    return writeHelpers;
  }

  async function lookupPoolForPosition(positionAddress: string): Promise<string> {
    const cached = positionToPool.get(positionAddress);
    if (cached) return cached;
    // Force a fresh snapshot — this is the fallback when the client is asked to close/claim
    // for a position it hasn't seen yet this session.
    await client.getMyPositions({ force: true });
    const found = positionToPool.get(positionAddress);
    if (!found) {
      throw new Error(`Meteora: pool for position ${positionAddress} not found in snapshot`);
    }
    return found;
  }

  async function fetchPositionsSnapshot(): Promise<PositionsSnapshot> {
    const sdk = await loadDlmmSdk();
    const web3 = await import("@solana/web3.js");
    const walletPk = new web3.PublicKey(wallet.address);

    // The SDK exposes `getAllLbPairPositionsByUser` — a single RPC batch returning
    // every position across every pool this wallet touches. Faster than iterating pools.
    // We reach through `default` to survive both CJS-default and named-export shapes.
    const container = (sdk.default ?? sdk) as unknown as {
      getAllLbPairPositionsByUser?: (
        connection: unknown,
        wallet: unknown,
      ) => Promise<Map<string, unknown>>;
    };
    if (typeof container.getAllLbPairPositionsByUser !== "function") {
      throw new Error("Meteora SDK: getAllLbPairPositionsByUser not found on default export");
    }
    const pairMap = await container.getAllLbPairPositionsByUser(connection.raw, walletPk);

    // Collect (pool → positions) so we can fetch datapi PnL in parallel per pool.
    const rawEntries: Array<{
      poolPk: string;
      baseMint: string | null;
      positions: Array<{
        addr: string;
        lower: number;
        upper: number;
        active: number;
        inRange: boolean;
      }>;
    }> = [];
    for (const entry of pairMap.values()) {
      const bag = entry as {
        publicKey?: { toBase58: () => string };
        lbPair?: { tokenXMint?: { toBase58: () => string } };
        tokenX?: { publicKey?: { toBase58: () => string } };
        tokenY?: { publicKey?: { toBase58: () => string } };
        lbPairPositionsData?: Array<{
          publicKey: { toBase58: () => string };
          positionData: {
            lowerBinId: number;
            upperBinId: number;
            activeBinId: number;
            totalXAmount: string;
            totalYAmount: string;
            feeX: string;
            feeY: string;
          };
        }>;
      };
      const poolPk = bag.publicKey?.toBase58();
      const baseMint = bag.lbPair?.tokenXMint?.toBase58() ?? bag.tokenX?.publicKey?.toBase58() ?? null;
      if (!poolPk || !bag.lbPairPositionsData) continue;
      const positions: Array<{
        addr: string;
        lower: number;
        upper: number;
        active: number;
        inRange: boolean;
      }> = [];
      for (const rec of bag.lbPairPositionsData) {
        const posAddr = rec.publicKey.toBase58();
        const pd = rec.positionData;
        const inRange = pd.activeBinId >= pd.lowerBinId && pd.activeBinId <= pd.upperBinId;
        positions.push({
          addr: posAddr,
          lower: pd.lowerBinId,
          upper: pd.upperBinId,
          active: pd.activeBinId,
          inRange,
        });
      }
      rawEntries.push({ poolPk, baseMint, positions });
    }

    // Fetch price + datapi PnL in parallel. Both are best-effort — a failure downgrades
    // the enrichment for that pool to `null` fields with `pnl_pct_suspicious: true`.
    const solUsdPromise: Promise<number | null> = price.getSolUsdPrice().catch(() => null);
    const pnlPerPool = new Map<string, Map<string, DatapiPnlRecord>>();
    if (opts.pnl) {
      const pnlFetcher = opts.pnl;
      await Promise.all(
        rawEntries.map(async ({ poolPk }) => {
          const map = await pnlFetcher(poolPk, wallet.address);
          pnlPerPool.set(poolPk, map);
        }),
      );
    }
    const solUsd = await solUsdPromise;

    // Resolve base-mint symbols once (parallel, cached) so pairs read as Wukong/SOL.
    const symbolByMint = new Map<string, string | null>();
    await Promise.all(
      [...new Set(rawEntries.map((e) => e.baseMint).filter((m): m is string => !!m))].map(
        async (mint) => {
          symbolByMint.set(mint, await resolveSymbol(mint));
        },
      ),
    );

    const positions: OnChainPosition[] = [];
    const fetchedAt = clock.now().toISOString();
    for (const { poolPk, baseMint, positions: rawPositions } of rawEntries) {
      const poolPnlMap = pnlPerPool.get(poolPk);
      for (const rp of rawPositions) {
        const datapi = poolPnlMap?.get(rp.addr) ?? null;
        const reported = datapi
          ? (solMode ? datapi.reportedPctSol : datapi.reportedPctUsd)
          : null;
        const derived = datapi ? deriveOpenPnlPct(datapi, solMode) : null;
        const pnl = assessPnl(reported, derived, pnlMaxDiffPct);
        if (pnl.divergent && datapi) {
          logger.warn(
            "meteora-pnl",
            `pnl divergence for ${rp.addr.slice(0, 8)} — reported=${reported} derived=${derived}`,
            { pool: poolPk, divergence_pct: pnl.divergence_pct },
          );
        }
        const unclaimedFeesUsd = datapi
          ? solMode && solUsd != null
            ? roundNum(datapi.unclaimedFeeSol * solUsd, 4)
            : roundNum(datapi.unclaimedFeeUsd, 4)
          : 0;
        const totalValueUsd = datapi
          ? solMode && solUsd != null && datapi.balancesSol != null
            ? roundNum(datapi.balancesSol * solUsd, 4)
            : datapi.balancesUsd != null
              ? roundNum(datapi.balancesUsd, 4)
              : null
          : null;
        const claimedFeesUsd = datapi
          ? solMode && solUsd != null
            ? roundNum(datapi.feesSol * solUsd, 4)
            : roundNum(datapi.feesUsd, 4)
          : null;
        positionToPool.set(rp.addr, poolPk);
        positions.push({
          position: rp.addr,
          pool: poolPk,
          pair: `${(baseMint && symbolByMint.get(baseMint)) || baseMint?.slice(0, 4) || "?"}/SOL`,
          base_mint: baseMint,
          lower_bin: datapi?.lowerBinId ?? rp.lower,
          upper_bin: datapi?.upperBinId ?? rp.upper,
          active_bin: datapi?.poolActiveBinId ?? rp.active,
          in_range: datapi?.isOutOfRange != null ? !datapi.isOutOfRange : rp.inRange,
          unclaimed_fees_usd: unclaimedFeesUsd,
          pnl_pct: pnl.pnl_pct,
          pnl_pct_suspicious: pnl.pnl_pct_suspicious,
          total_value_usd: totalValueUsd,
          fee_per_tvl_24h: null,
          age_minutes: null,
          deposit_sol: datapi?.depositSol ?? null,
          deposit_usd: datapi?.depositUsd ?? null,
          claimed_fees_usd: claimedFeesUsd,
        });
      }
    }

    return {
      total_positions: positions.length,
      positions,
      wallet: wallet.address,
      fetched_at: fetchedAt,
    };
  }

  const client: ChainClient = {
    async getWalletBalance(): Promise<WalletBalance> {
      const lamports = await connection.getLamports(wallet.address);
      const sol = roundNum(lamportsToSol(lamports), 4);
      const solPrice = await price.getSolUsdPrice();
      return {
        sol,
        sol_usd: roundNum(sol * solPrice, 2),
        sol_price: solPrice,
        fetched_at: clock.now().toISOString(),
      };
    },

    async getWalletTokens(): Promise<WalletToken[]> {
      const web3 = await import("@solana/web3.js");
      const conn = connection.raw as InstanceType<typeof web3.Connection>;
      const owner = new web3.PublicKey(wallet.address);
      // Query BOTH SPL Token (classic) AND Token-2022. Post-2024 launchpads
      // (pump.fun / Jupiter Studio) mint tokens under Token-2022 by default,
      // and a classic-only query never sees them → the sweeper thinks the
      // wallet is empty even when it holds thousands of dollars of tokens.
      const TOKEN_PROGRAM_IDS = [
        new web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        new web3.PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
      ];
      let holdings: { mint: string; balance: number; raw: string }[] = [];
      for (const programId of TOKEN_PROGRAM_IDS) {
        try {
          const resp = await conn.getParsedTokenAccountsByOwner(owner, { programId });
          for (const { account } of resp.value) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const info = (account.data as any)?.parsed?.info;
            const mint: unknown = info?.mint;
            const amt: unknown = info?.tokenAmount?.uiAmount;
            const rawStr: unknown = info?.tokenAmount?.amount;
            if (typeof mint === "string" && typeof amt === "number" && amt > 0) {
              // `amount` is the raw base-unit integer STRING; keep it verbatim so callers can
              // swap the exact holding at full precision (uiAmount can't be reversed without
              // decimals, and Number() would lose precision above 2^53).
              const raw = typeof rawStr === "string" ? rawStr : "0";
              holdings.push({ mint, balance: amt, raw });
            }
          }
        } catch (err) {
          logger.warn("meteora", "getWalletTokens: token accounts fetch failed", {
            programId: programId.toBase58(),
            error: err instanceof Error ? err.message : String(err),
          });
          // Don't return early — the other program's accounts may still be reachable.
        }
      }
      if (holdings.length === 0) return [];
      // Batch-price via Jupiter (best-effort; unpriced tokens surface usd:null).
      const prices = await fetchJupiterPrices(holdings.map((h) => h.mint)).catch(
        (): Record<string, number> => ({}),
      );
      return holdings.map((h) => {
        const p = prices[h.mint];
        return {
          mint: h.mint,
          symbol: null,
          balance: h.balance,
          raw: h.raw,
          usd: typeof p === "number" ? roundNum(h.balance * p, 2) : null,
        };
      });
    },

    async getActiveBin(poolAddress: string): Promise<ActiveBin> {
      const sdk = await loadDlmmSdk();
      const web3 = await import("@solana/web3.js");
      const container = (sdk.default ?? sdk) as unknown as {
        create?: (connection: unknown, pubkey: unknown) => Promise<{ getActiveBin: () => Promise<{ binId: number; price: string; pricePerLamport?: string }> }>;
      };
      if (typeof container.create !== "function") {
        throw new Error("Meteora SDK: create(...) not found on default export");
      }
      const dlmm = await container.create(connection.raw, new web3.PublicKey(poolAddress));
      const bin = await dlmm.getActiveBin();
      return {
        binId: bin.binId,
        price: Number(bin.price),
        pricePerLamport: bin.pricePerLamport ?? String(bin.price),
      };
    },

    async getMyPositions(o: GetPositionsOptions = {}): Promise<PositionsSnapshot> {
      const force = o.force ?? false;
      const snap = await positionsCache.get(fetchPositionsSnapshot, force);
      // The snapshot loader already populated positionToPool for the fresh path; for cached
      // hits (older snapshot), re-hydrate the map so lookups stay valid until the next fetch.
      if (!force) {
        for (const p of snap.positions) positionToPool.set(p.position, p.pool);
      }
      return snap;
    },

    async deployPosition(args: DeployArgs): Promise<DeployResult> {
      const helpers = assertWritable("deployPosition");
      return helpers.deploy(args);
    },

    async closePosition(positionAddress: string, reason: string): Promise<CloseResult> {
      assertWritable("closePosition");
      const poolAddress = await lookupPoolForPosition(positionAddress);
      return closePositionAt(
        {
          connection,
          wallet,
          clock,
          logger,
          sdkLoader: opts.sdkLoader ?? defaultSdkLoader,
          sendTx: opts.sendTx ?? defaultSendTx,
          newPositionKeypair: opts.newPositionKeypair ?? defaultNewPositionKeypair,
          onWriteCommitted: () => positionsCache.invalidate(),
        },
        poolAddress,
        positionAddress,
        reason,
      );
    },

    async getClosedPositionPnl(
      poolAddress: string,
      positionAddress: string,
    ): Promise<ClosedPositionPnl | null> {
      const fetchClosed = opts.pnl?.closed;
      if (!fetchClosed) return null;
      const rec = (await fetchClosed(poolAddress, wallet.address)).get(positionAddress);
      if (!rec || rec.depositUsd == null) return null;
      return {
        position: positionAddress,
        deposits_usd: rec.depositUsd,
        withdrawals_usd: rec.withdrawalsUsd,
        fees_usd: rec.feesUsd,
      };
    },

    async claimFees(positionAddress: string): Promise<ClaimResult> {
      assertWritable("claimFees");
      const poolAddress = await lookupPoolForPosition(positionAddress);
      return claimFeesForPosition(
        {
          connection,
          wallet,
          clock,
          logger,
          sdkLoader: opts.sdkLoader ?? defaultSdkLoader,
          sendTx: opts.sendTx ?? defaultSendTx,
          newPositionKeypair: opts.newPositionKeypair ?? defaultNewPositionKeypair,
          onWriteCommitted: () => positionsCache.invalidate(),
        },
        poolAddress,
        positionAddress,
      );
    },
  };
  return client;
}
