import type { Clock } from "../../../ports/clock.js";
import type { Logger } from "../../../ports/logger.js";
import type { SolanaConnection, WalletKeypair } from "../../../ports/solana.js";
import type {
  ClaimResult,
  CloseResult,
  DeployArgs,
  DeployResult,
} from "../../../domain/schemas/chain.js";
import { planDeploy, WIDE_RANGE_THRESHOLD } from "../../../domain/rules/deploy-planning.js";

/**
 * Phase 15B — real Meteora write paths, GATED.
 *
 * The daemon must pass `writesEnabled: true` (driven by `MERIDIAN_WRITE_UNSAFE=true`)
 * to construct write helpers; otherwise `createMeteoraChainClient` keeps throwing
 * `MeteoraWritePathNotPortedError`. This makes accidental real-money moves impossible
 * without an explicit opt-in.
 *
 * Live-chain smoke test is deliberately out of scope here — see HANDOFF §"Next session"
 * (b) DRY_RUN parallel 24h + (c) explicit user sign-off before any mainnet run.
 *
 * Wide-range path (totalBins > 69, multi-tx `createExtendedEmptyPosition` +
 * `addLiquidityByStrategyChunkable`) is currently deferred — deploys that exceed the
 * threshold refuse loudly.
 */

/** Test hook — signs + sends a Meteora SDK `Transaction` object, returns the signature. */
export type SendTx = (tx: unknown, signers: unknown[]) => Promise<string>;

/** Test hook — mints a fresh `Keypair` for the position account. */
export type NewPositionKeypair = () => Promise<{
  publicKey: unknown;
  address: string;
  raw: unknown;
}>;

/** Test hook — provides the SDK namespace. Skips the CJS lazy-load in unit tests. */
export type SdkLoader = () => Promise<SdkNamespace>;

export interface SdkNamespace {
  default?: unknown;
  StrategyType?: {
    Spot: unknown;
    Curve: unknown;
    BidAsk: unknown;
  };
}

interface SdkContainer {
  create?: (connection: unknown, poolPk: unknown) => Promise<PoolHandle>;
}

interface PoolHandle {
  lbPair?: { tokenXMint?: { toBase58: () => string } };
  getActiveBin: () => Promise<{ binId: number; price: string | number; pricePerLamport?: string }>;
  initializePositionAndAddLiquidityByStrategy: (args: {
    positionPubKey: unknown;
    user: unknown;
    totalXAmount: unknown;
    totalYAmount: unknown;
    strategy: { minBinId: number; maxBinId: number; strategyType: unknown };
    slippage: number;
  }) => Promise<unknown>;
  createExtendedEmptyPosition: (
    minBinId: number,
    maxBinId: number,
    positionPubKey: unknown,
    userPubKey: unknown,
  ) => Promise<unknown | unknown[]>;
  addLiquidityByStrategyChunkable: (args: {
    positionPubKey: unknown;
    user: unknown;
    totalXAmount: unknown;
    totalYAmount: unknown;
    strategy: { minBinId: number; maxBinId: number; strategyType: unknown };
    slippage: number;
  }) => Promise<unknown | unknown[]>;
  claimSwapFee: (args: {
    owner: unknown;
    position: unknown;
  }) => Promise<unknown[]>;
  getPosition: (positionPubKey: unknown) => Promise<{
    positionData: {
      lowerBinId: number;
      upperBinId: number;
      positionBinData?: Array<{ positionLiquidity: string | number }>;
    };
  }>;
  removeLiquidity: (args: {
    user: unknown;
    position: unknown;
    fromBinId: number;
    toBinId: number;
    bps: unknown;
    shouldClaimAndClose: boolean;
  }) => Promise<unknown | unknown[]>;
  closePosition: (args: { owner: unknown; position: { publicKey: unknown } }) => Promise<unknown>;
}

/** Turn a base58 address into whatever opaque handle the SDK's `PublicKey` needs. */
export type PubkeyFromAddress = (address: string) => Promise<unknown>;

export interface WritePathsDeps {
  connection: SolanaConnection;
  wallet: WalletKeypair;
  clock: Clock;
  logger: Logger;
  /** Loader for the Meteora SDK namespace. Real callers pass a lazy `@meteora-ag/dlmm` import. */
  sdkLoader: SdkLoader;
  /** Signer/sender. Real callers wrap `sendAndConfirmTransaction`. */
  sendTx: SendTx;
  /** Builder for a fresh position `Keypair`. Real callers use `web3.Keypair.generate`. */
  newPositionKeypair: NewPositionKeypair;
  /** Build a PublicKey handle for a base58 address. Test hook — real callers use `web3.PublicKey`. */
  pubkeyFromAddress?: PubkeyFromAddress;
  /** Called after any state-mutating tx lands, so the read layer refetches. */
  onWriteCommitted?: () => void;
  /** SOL→lamports scale. Kept as a dep so tests can pin an easy scale. */
  lamportsPerSol?: bigint;
}

async function defaultPubkeyFromAddress(address: string): Promise<unknown> {
  const web3 = await import("@solana/web3.js");
  return new web3.PublicKey(address);
}

const DEFAULT_LAMPORTS_PER_SOL = 1_000_000_000n;

function toStrategyType(sdk: SdkNamespace, strategy: DeployArgs["strategy"]): unknown {
  const enums = sdk.StrategyType ?? (sdk.default as { StrategyType?: SdkNamespace["StrategyType"] })?.StrategyType;
  if (!enums) {
    throw new Error("Meteora SDK: StrategyType enum not found on module");
  }
  switch (strategy) {
    case "spot":
      return enums.Spot;
    case "curve":
      return enums.Curve;
    case "bid_ask":
      return enums.BidAsk;
  }
}

function getContainer(sdk: SdkNamespace): SdkContainer {
  return (sdk.default ?? sdk) as SdkContainer;
}

async function loadPool(deps: WritePathsDeps, poolAddress: string): Promise<PoolHandle> {
  const sdk = await deps.sdkLoader();
  const container = getContainer(sdk);
  if (typeof container.create !== "function") {
    throw new Error("Meteora SDK: create(...) not found on default export");
  }
  const buildPk = deps.pubkeyFromAddress ?? defaultPubkeyFromAddress;
  const pool = await container.create(deps.connection.raw, await buildPk(poolAddress));
  return pool;
}

export interface DeployPositionHelper {
  deploy(args: DeployArgs): Promise<DeployResult>;
}

export interface ClosePositionHelper {
  close(positionAddress: string, reason: string): Promise<CloseResult>;
}

export interface ClaimFeesHelper {
  claim(positionAddress: string): Promise<ClaimResult>;
}

export interface MeteoraWriteHelpers {
  deploy: DeployPositionHelper["deploy"];
  close: ClosePositionHelper["close"];
  claim: ClaimFeesHelper["claim"];
}

/**
 * Build real deploy / close / claim helpers. The daemon calls this ONLY when
 * `MERIDIAN_WRITE_UNSAFE=true`; otherwise the returned client keeps stubbing writes
 * with `MeteoraWritePathNotPortedError`.
 */
export function createMeteoraWriteHelpers(deps: WritePathsDeps): MeteoraWriteHelpers {
  const scale = deps.lamportsPerSol ?? DEFAULT_LAMPORTS_PER_SOL;

  function toLamports(sol: number): bigint {
    if (!Number.isFinite(sol) || sol < 0) {
      throw new Error(`toLamports: expected non-negative finite SOL, got ${sol}`);
    }
    // Round-half-away-from-zero preserves the JS behavior for typical config values.
    return BigInt(Math.round(sol * Number(scale)));
  }

  async function deploy(args: DeployArgs): Promise<DeployResult> {
    const sdk = await deps.sdkLoader();
    const strategyType = toStrategyType(sdk, args.strategy);

    const pool = await loadPool(deps, args.pool_address);
    const activeBin = await pool.getActiveBin();
    const activePrice = Number(activeBin.price);
    const binStep =
      typeof args.bin_step === "number" && Number.isFinite(args.bin_step) && args.bin_step > 0
        ? args.bin_step
        : 100;
    const plan = planDeploy({
      poolAddress: args.pool_address,
      activeBinId: activeBin.binId,
      binStep,
      activePrice: Number.isFinite(activePrice) ? activePrice : 0,
      strategy: args.strategy,
      binsBelow: args.bins_below,
      binsAbove: args.bins_above,
      amountY: args.amount_sol,
      ...(args.allow_tiny_range ? { allowTinyRange: true } : {}),
    });

    const buildPk = deps.pubkeyFromAddress ?? defaultPubkeyFromAddress;
    const newPosition = await deps.newPositionKeypair();
    const walletPk = await buildPk(deps.wallet.address);
    // The DLMM SDK calls totalXAmount.isZero()/totalYAmount.isZero() — those are
    // bn.js methods. Passing a native bigint throws "totalYAmount.isZero is not a
    // function" and reverts the deploy. Convert lamports (bigint) → BN via decimal string.
    const BN = (await import("bn.js")).default;
    const totalYLamports = new BN(toLamports(plan.amountY).toString());
    const totalXLamports = new BN(toLamports(plan.amountX).toString());

    const txHashes: string[] = [];

    if (plan.isWideRange) {
      // ── Wide-range path — mirrors tools/dlmm.js:781-817 ─────────────
      // Solana caps inner-instruction realloc at 10240 bytes, so wide positions
      // can't fit in one `initializePosition` ix. Two phases:
      //   1) createExtendedEmptyPosition → 1..N txs, first one signs with newPosition
      //   2) addLiquidityByStrategyChunkable → 1..N txs, wallet-only signers
      deps.logger.warn("meteora-write", "deployPosition (WIDE RANGE)", {
        pool: args.pool_address,
        strategy: args.strategy,
        minBinId: plan.minBinId,
        maxBinId: plan.maxBinId,
        totalBins: plan.totalBins,
        amount_sol: plan.amountY,
      });
      const createTxsRaw = await pool.createExtendedEmptyPosition(
        plan.minBinId,
        plan.maxBinId,
        newPosition.publicKey,
        walletPk,
      );
      const createTxs = Array.isArray(createTxsRaw) ? createTxsRaw : [createTxsRaw];
      for (let i = 0; i < createTxs.length; i += 1) {
        const signers = i === 0 ? [deps.wallet.raw, newPosition.raw] : [deps.wallet.raw];
        const hash = await deps.sendTx(createTxs[i], signers);
        txHashes.push(hash);
        deps.logger.info("meteora-write", `wide-range create tx ${i + 1}/${createTxs.length}`, {
          tx: hash,
        });
      }

      const addTxsRaw = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: walletPk,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: {
          minBinId: plan.minBinId,
          maxBinId: plan.maxBinId,
          strategyType,
        },
        slippage: 10, // 10 (percent) — matches tools/dlmm.js:810
      });
      const addTxs = Array.isArray(addTxsRaw) ? addTxsRaw : [addTxsRaw];
      for (let i = 0; i < addTxs.length; i += 1) {
        const hash = await deps.sendTx(addTxs[i], [deps.wallet.raw]);
        txHashes.push(hash);
        deps.logger.info(
          "meteora-write",
          `wide-range add-liquidity tx ${i + 1}/${addTxs.length}`,
          { tx: hash },
        );
      }
    } else {
      // ── Standard range (≤69 bins) ─────────────────────────────────
      deps.logger.info("meteora-write", "deployPosition (standard range)", {
        pool: args.pool_address,
        strategy: args.strategy,
        minBinId: plan.minBinId,
        maxBinId: plan.maxBinId,
        amount_sol: plan.amountY,
      });
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: walletPk,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: {
          minBinId: plan.minBinId,
          maxBinId: plan.maxBinId,
          strategyType,
        },
        slippage: 1000, // 10% in bps — same value used by tools/dlmm.js:826
      });
      txHashes.push(await deps.sendTx(tx, [deps.wallet.raw, newPosition.raw]));
    }

    deps.onWriteCommitted?.();

    return {
      success: true,
      position_address: newPosition.address,
      pool_address: args.pool_address,
      strategy: args.strategy,
      lower_bin: plan.minBinId,
      upper_bin: plan.maxBinId,
      active_bin: activeBin.binId,
      amount_sol: plan.amountY,
      tx: txHashes[0] ?? null,
      dry_run: false,
      ...(binStep && binStep > 0 ? { bin_step: binStep } : {}),
    };
  }

  async function claim(positionAddress: string): Promise<ClaimResult> {
    // Real callers look up the pool address via a prior `getMyPositions` call.
    // The helper takes the pool from the caller-injected `positionToPoolLookup` to
    // avoid a hard SDK+RPC dependency here — but for Phase 15B we accept that the
    // caller drives claim after `getMyPositions`. See client.ts for the wiring.
    throw new Error(
      "createMeteoraWriteHelpers.claim requires a pool lookup — call via client.ts which supplies it",
    );
  }

  async function close(_positionAddress: string, _reason: string): Promise<CloseResult> {
    throw new Error(
      "createMeteoraWriteHelpers.close requires a pool lookup — call via client.ts which supplies it",
    );
  }

  return { deploy, close, claim };
}

/**
 * Claim-fees helper factored around a known pool address (client.ts resolves the pool
 * from the position snapshot before calling this).
 */
export async function claimFeesForPosition(
  deps: WritePathsDeps,
  poolAddress: string,
  positionAddress: string,
): Promise<ClaimResult> {
  const buildPk = deps.pubkeyFromAddress ?? defaultPubkeyFromAddress;
  const pool = await loadPool(deps, poolAddress);
  const positionPubKey = await buildPk(positionAddress);
  const positionData = await pool.getPosition(positionPubKey);
  const walletPk = await buildPk(deps.wallet.address);
  const txs = await pool.claimSwapFee({ owner: walletPk, position: positionData });
  if (!txs || txs.length === 0) {
    return {
      success: false,
      position_address: positionAddress,
      claimed_usd: 0,
      tx: null,
      dry_run: false,
    };
  }
  const txHashes: string[] = [];
  for (const tx of txs) {
    const hash = await deps.sendTx(tx, [deps.wallet.raw]);
    txHashes.push(hash);
  }
  deps.onWriteCommitted?.();
  deps.logger.info("meteora-write", `claimFees landed (${txHashes.length} tx)`, {
    position: positionAddress,
    txs: txHashes,
  });
  return {
    success: true,
    position_address: positionAddress,
    // USD accounting requires enrichment from datapi / price oracle — deferred to a
    // higher-level orchestrator that decorates the ClaimResult before it reaches the
    // decision log. Here we report the on-chain success plus the primary tx.
    claimed_usd: 0,
    tx: txHashes[0] ?? null,
    dry_run: false,
  };
}

/**
 * Close-position helper. Mirrors the JS two-phase pattern (removeLiquidity when the
 * position still holds bin balances; closePosition otherwise) without the LPAgent relay,
 * which stays out of the TS rewrite for now.
 */
export async function closePositionAt(
  deps: WritePathsDeps,
  poolAddress: string,
  positionAddress: string,
  reason: string,
): Promise<CloseResult> {
  const BN = (await import("bn.js")).default;
  const buildPk = deps.pubkeyFromAddress ?? defaultPubkeyFromAddress;
  const pool = await loadPool(deps, poolAddress);
  const positionPubKey = await buildPk(positionAddress);
  const positionData = await pool.getPosition(positionPubKey);
  const pd = positionData.positionData;
  const bins = Array.isArray(pd.positionBinData) ? pd.positionBinData : [];
  const hasLiquidity = bins.some((b) => new BN(String(b.positionLiquidity ?? "0")).gt(new BN(0)));

  const txHashes: string[] = [];
  if (hasLiquidity) {
    deps.logger.info("meteora-write", "closePosition: removing liquidity", {
      position: positionAddress,
      from_bin: pd.lowerBinId,
      to_bin: pd.upperBinId,
    });
    const removeTx = await pool.removeLiquidity({
      user: await buildPk(deps.wallet.address),
      position: positionPubKey,
      fromBinId: pd.lowerBinId,
      toBinId: pd.upperBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });
    const arr = Array.isArray(removeTx) ? removeTx : [removeTx];
    for (const tx of arr) {
      const hash = await deps.sendTx(tx, [deps.wallet.raw]);
      txHashes.push(hash);
    }
  } else {
    deps.logger.info("meteora-write", "closePosition: no liquidity → close account only", {
      position: positionAddress,
    });
    const closeTx = await pool.closePosition({
      owner: await buildPk(deps.wallet.address),
      position: { publicKey: positionPubKey },
    });
    const hash = await deps.sendTx(closeTx, [deps.wallet.raw]);
    txHashes.push(hash);
  }
  deps.onWriteCommitted?.();

  const baseMint = pool.lbPair?.tokenXMint?.toBase58() ?? null;
  return {
    success: true,
    position_address: positionAddress,
    pool_address: poolAddress,
    base_mint: baseMint,
    // Final PnL / value / fees roll up from the datapi enrichment layer — the write
    // helper reports the on-chain close only, higher-level orchestration decorates.
    final_pnl_pct: null,
    final_value_usd: null,
    fees_earned_usd: 0,
    reason,
    tx: txHashes[0] ?? null,
    dry_run: false,
  };
}
