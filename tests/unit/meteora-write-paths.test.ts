import { describe, it, expect, vi } from "vitest";
import { fixedClock } from "../../src/ports/clock.js";
import { nullLogger } from "../../src/ports/logger.js";
import type { SolanaConnection, WalletKeypair } from "../../src/ports/solana.js";
import {
  createMeteoraWriteHelpers,
  claimFeesForPosition,
  closePositionAt,
  type SdkNamespace,
  type WritePathsDeps,
} from "../../src/adapters/chain/meteora/write-paths.ts";

const clock = fixedClock("2026-07-05T12:00:00.000Z");

const wallet: WalletKeypair = {
  address: "WalletAddr11111111111111111111111111111111",
  raw: { __wallet: true },
};

function fakeConnection(): SolanaConnection {
  return { endpoint: "fake://x", raw: { __conn: true }, async getLamports() { return 0n; } };
}

interface PoolStub {
  activeBinId: number;
  binStep?: number;
  hasLiquidity: boolean;
  claimTxs: unknown[];
}

function makeSdk(pool: PoolStub): {
  sdk: SdkNamespace;
  spy: {
    initialize: ReturnType<typeof vi.fn>;
    createExtended: ReturnType<typeof vi.fn>;
    addLiquidityChunkable: ReturnType<typeof vi.fn>;
    removeLiquidity: ReturnType<typeof vi.fn>;
    closePosition: ReturnType<typeof vi.fn>;
    claimSwapFee: ReturnType<typeof vi.fn>;
    getPosition: ReturnType<typeof vi.fn>;
  };
} {
  const spy = {
    initialize: vi.fn(async () => ({ __tx: "INIT_TX" })),
    createExtended: vi.fn(async () => ({ __tx: "CREATE_EXT_TX" })),
    addLiquidityChunkable: vi.fn(async () => ({ __tx: "ADD_LIQ_TX" })),
    removeLiquidity: vi.fn(async () => ({ __tx: "REMOVE_TX" })),
    closePosition: vi.fn(async () => ({ __tx: "CLOSE_TX" })),
    claimSwapFee: vi.fn(async () => pool.claimTxs),
    getPosition: vi.fn(async () => ({
      positionData: {
        lowerBinId: -10,
        upperBinId: 5,
        positionBinData: pool.hasLiquidity ? [{ positionLiquidity: "1000" }] : [],
      },
    })),
  };
  const sdk: SdkNamespace = {
    default: {
      create: async () => ({
        lbPair: { tokenXMint: { toBase58: () => "BaseMintAaaa" }, binStep: pool.binStep },
        getActiveBin: async () => ({
          binId: pool.activeBinId,
          price: 1.05,
          pricePerLamport: "1.05",
        }),
        initializePositionAndAddLiquidityByStrategy: spy.initialize,
        createExtendedEmptyPosition: spy.createExtended,
        addLiquidityByStrategyChunkable: spy.addLiquidityChunkable,
        removeLiquidity: spy.removeLiquidity,
        closePosition: spy.closePosition,
        claimSwapFee: spy.claimSwapFee,
        getPosition: spy.getPosition,
      }),
    },
    StrategyType: { Spot: "SPOT", Curve: "CURVE", BidAsk: "BIDASK" },
  };
  return { sdk, spy };
}

function makeDeps(sdk: SdkNamespace, sendTxImpl?: (tx: unknown, signers: unknown[]) => Promise<string>) {
  const sendTx = vi.fn(
    sendTxImpl ?? (async (_tx: unknown, _signers: unknown[]) => "TX_HASH_ABC"),
  );
  const newPositionKeypair = vi.fn(async () => ({
    publicKey: { __posPk: true },
    address: "PositionAddr222222222222222222222222222222222",
    raw: { __posKp: true },
  }));
  const deps: WritePathsDeps = {
    connection: fakeConnection(),
    wallet,
    clock,
    logger: nullLogger,
    sdkLoader: async () => sdk,
    sendTx,
    newPositionKeypair,
    pubkeyFromAddress: async (addr: string) => ({ __pk: addr }),
    onWriteCommitted: vi.fn(),
  };
  return { deps, sendTx, newPositionKeypair };
}

describe("createMeteoraWriteHelpers.deploy", () => {
  it("reports the pool's own bin_step when the caller omits it, and none when unknown", async () => {
    const args = { pool_address: "PoolAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", amount_sol: 0.5, strategy: "spot" as const, bins_below: 40, bins_above: 0 };
    const known = makeSdk({ activeBinId: 500, hasLiquidity: false, claimTxs: [], binStep: 80 });
    expect((await createMeteoraWriteHelpers(makeDeps(known.sdk).deps).deploy(args)).bin_step).toBe(80);
    const unknown = makeSdk({ activeBinId: 500, hasLiquidity: false, claimTxs: [] });
    const r = await createMeteoraWriteHelpers(makeDeps(unknown.sdk).deps).deploy(args);
    expect(r.success).toBe(true);
    expect(r.bin_step).toBeUndefined(); // the 100 fallback is for price display only, never recorded
  });

  it("plans, initializes, sends, and returns a DeployResult", async () => {
    const { sdk, spy } = makeSdk({ activeBinId: 500, hasLiquidity: false, claimTxs: [] });
    const { deps, sendTx, newPositionKeypair } = makeDeps(sdk);
    const helpers = createMeteoraWriteHelpers(deps);
    const result = await helpers.deploy({
      pool_address: "PoolAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      amount_sol: 0.5,
      strategy: "bid_ask",
      bins_below: 40,
      bins_above: 0,
      bin_step: 100,
    });
    expect(result.success).toBe(true);
    expect(result.tx).toBe("TX_HASH_ABC");
    expect(result.dry_run).toBe(false);
    expect(result.lower_bin).toBe(460);
    expect(result.upper_bin).toBe(500);
    expect(result.active_bin).toBe(500);
    expect(result.strategy).toBe("bid_ask");
    expect(spy.initialize).toHaveBeenCalledTimes(1);
    const call = spy.initialize.mock.calls[0]![0] as {
      strategy: { strategyType: string };
      totalXAmount: { isZero: () => boolean; toString: () => string };
      totalYAmount: { isZero: () => boolean; toString: () => string };
      slippage: number;
    };
    expect(call.strategy.strategyType).toBe("BIDASK");
    // MUST be a BN (bn.js), not a native bigint — the SDK calls .isZero() on it.
    // A bigint here throws "totalYAmount.isZero is not a function" and reverts the deploy.
    expect(typeof call.totalYAmount.isZero).toBe("function");
    expect(call.totalYAmount.toString()).toBe("500000000"); // 0.5 SOL in lamports
    expect(call.totalYAmount.isZero()).toBe(false);
    expect(call.totalXAmount.isZero()).toBe(true); // single-side SOL → X is 0
    expect(call.slippage).toBe(1000);
    expect(sendTx).toHaveBeenCalledTimes(1);
    const signers = sendTx.mock.calls[0]![1];
    expect(signers).toHaveLength(2);
    expect(newPositionKeypair).toHaveBeenCalledTimes(1);
    expect(deps.onWriteCommitted).toHaveBeenCalledTimes(1);
  });

  it("runs the wide-range path when totalBins > 69", async () => {
    const { sdk, spy } = makeSdk({ activeBinId: 500, hasLiquidity: false, claimTxs: [] });
    const hashes = ["CREATE_1", "CREATE_2", "ADD_1", "ADD_2"];
    let idx = 0;
    const { deps, sendTx } = makeDeps(sdk, async () => hashes[idx++]!);
    // Two txs per phase.
    spy.createExtended.mockResolvedValueOnce([{ __t: "c1" }, { __t: "c2" }]);
    spy.addLiquidityChunkable.mockResolvedValueOnce([{ __t: "a1" }, { __t: "a2" }]);
    const helpers = createMeteoraWriteHelpers(deps);
    const result = await helpers.deploy({
      pool_address: "PoolCcccccccccccccccccccccccccccccccccccc",
      amount_sol: 0.5,
      strategy: "bid_ask",
      bins_below: 70,
      bins_above: 0,
      bin_step: 100,
    });
    expect(result.success).toBe(true);
    expect(result.tx).toBe("CREATE_1");
    expect(spy.initialize).not.toHaveBeenCalled();
    expect(spy.createExtended).toHaveBeenCalledTimes(1);
    expect(spy.addLiquidityChunkable).toHaveBeenCalledTimes(1);
    // 2 create txs + 2 add-liquidity txs.
    expect(sendTx).toHaveBeenCalledTimes(4);
    // First create tx signs with wallet + position; rest sign wallet-only.
    const firstSigners = sendTx.mock.calls[0]![1];
    const secondSigners = sendTx.mock.calls[1]![1];
    const thirdSigners = sendTx.mock.calls[2]![1];
    expect(firstSigners).toHaveLength(2);
    expect(secondSigners).toHaveLength(1);
    expect(thirdSigners).toHaveLength(1);
    // Add-liquidity slippage matches JS reference (10, not bps).
    const addCall = spy.addLiquidityChunkable.mock.calls[0]![0] as { slippage: number };
    expect(addCall.slippage).toBe(10);
  });

  it("handles wide-range createExtendedEmptyPosition returning a single tx", async () => {
    const { sdk, spy } = makeSdk({ activeBinId: 500, hasLiquidity: false, claimTxs: [] });
    const { deps, sendTx } = makeDeps(sdk);
    spy.createExtended.mockResolvedValueOnce({ __t: "one-shot" }); // NOT an array
    spy.addLiquidityChunkable.mockResolvedValueOnce({ __t: "one-add" });
    const helpers = createMeteoraWriteHelpers(deps);
    const result = await helpers.deploy({
      pool_address: "PoolCcccccccccccccccccccccccccccccccccccc",
      amount_sol: 0.5,
      strategy: "bid_ask",
      bins_below: 70,
      bins_above: 0,
      bin_step: 100,
    });
    expect(result.success).toBe(true);
    expect(sendTx).toHaveBeenCalledTimes(2);
  });

  it("propagates a plan error before touching the SDK", async () => {
    const { sdk, spy } = makeSdk({ activeBinId: 500, hasLiquidity: false, claimTxs: [] });
    const { deps, sendTx } = makeDeps(sdk);
    const helpers = createMeteoraWriteHelpers(deps);
    await expect(
      helpers.deploy({
        pool_address: "PoolCcccccccccccccccccccccccccccccccccccc",
        amount_sol: 0.5,
        strategy: "spot",
        bins_below: 10, // below MIN_SAFE_BINS_BELOW = 35
        bins_above: 0,
        bin_step: 100,
      }),
    ).rejects.toThrow(/safety floor/);
    expect(spy.initialize).not.toHaveBeenCalled();
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("maps strategy → StrategyType enum", async () => {
    const cases: Array<["spot" | "curve" | "bid_ask", string]> = [
      ["spot", "SPOT"],
      ["curve", "CURVE"],
      ["bid_ask", "BIDASK"],
    ];
    for (const [strategy, expected] of cases) {
      const { sdk, spy } = makeSdk({ activeBinId: 500, hasLiquidity: false, claimTxs: [] });
      const { deps } = makeDeps(sdk);
      const helpers = createMeteoraWriteHelpers(deps);
      await helpers.deploy({
        pool_address: "PoolCcccccccccccccccccccccccccccccccccccc",
        amount_sol: 0.5,
        strategy,
        bins_below: 40,
        bins_above: 0,
        bin_step: 100,
      });
      const call = spy.initialize.mock.calls[0]![0] as { strategy: { strategyType: string } };
      expect(call.strategy.strategyType).toBe(expected);
    }
  });
});

describe("claimFeesForPosition", () => {
  it("sends every claim tx, returns first hash", async () => {
    const { sdk, spy } = makeSdk({
      activeBinId: 100,
      hasLiquidity: false,
      claimTxs: [{ __t: "A" }, { __t: "B" }],
    });
    const hashes = ["HASH_A", "HASH_B"];
    let idx = 0;
    const { deps, sendTx } = makeDeps(sdk, async () => hashes[idx++]!);
    const result = await claimFeesForPosition(deps, "PoolBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Pos1111111111111111111111111111111111111111");
    expect(result.success).toBe(true);
    expect(result.tx).toBe("HASH_A");
    expect(sendTx).toHaveBeenCalledTimes(2);
    expect(spy.claimSwapFee).toHaveBeenCalledTimes(1);
    expect(deps.onWriteCommitted).toHaveBeenCalledTimes(1);
  });

  it("returns success=false when no claim txs are produced", async () => {
    const { sdk, spy } = makeSdk({ activeBinId: 100, hasLiquidity: false, claimTxs: [] });
    const { deps, sendTx } = makeDeps(sdk);
    const result = await claimFeesForPosition(deps, "PoolBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Pos1111111111111111111111111111111111111111");
    expect(result.success).toBe(false);
    expect(result.tx).toBeNull();
    expect(sendTx).not.toHaveBeenCalled();
    expect(spy.claimSwapFee).toHaveBeenCalledTimes(1);
    expect(deps.onWriteCommitted).not.toHaveBeenCalled();
  });
});

describe("closePositionAt", () => {
  it("removes liquidity when position still holds bin balances", async () => {
    const { sdk, spy } = makeSdk({ activeBinId: 100, hasLiquidity: true, claimTxs: [] });
    const { deps, sendTx } = makeDeps(sdk);
    const result = await closePositionAt(deps, "PoolBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Pos1111111111111111111111111111111111111111", "stop_loss");
    expect(result.success).toBe(true);
    expect(result.reason).toBe("stop_loss");
    expect(result.base_mint).toBe("BaseMintAaaa");
    expect(spy.removeLiquidity).toHaveBeenCalledTimes(1);
    expect(spy.closePosition).not.toHaveBeenCalled();
    const removeCall = spy.removeLiquidity.mock.calls[0]![0] as {
      shouldClaimAndClose: boolean;
      fromBinId: number;
      toBinId: number;
    };
    expect(removeCall.shouldClaimAndClose).toBe(true);
    expect(removeCall.fromBinId).toBe(-10);
    expect(removeCall.toBinId).toBe(5);
    expect(sendTx).toHaveBeenCalledTimes(1);
    expect(deps.onWriteCommitted).toHaveBeenCalledTimes(1);
  });

  it("uses closePosition when no liquidity remains", async () => {
    const { sdk, spy } = makeSdk({ activeBinId: 100, hasLiquidity: false, claimTxs: [] });
    const { deps, sendTx } = makeDeps(sdk);
    const result = await closePositionAt(deps, "PoolBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Pos1111111111111111111111111111111111111111", "low_yield");
    expect(result.success).toBe(true);
    expect(spy.removeLiquidity).not.toHaveBeenCalled();
    expect(spy.closePosition).toHaveBeenCalledTimes(1);
    expect(sendTx).toHaveBeenCalledTimes(1);
  });

  it("expands array-return removeLiquidity into multiple sends", async () => {
    const { sdk, spy } = makeSdk({ activeBinId: 100, hasLiquidity: true, claimTxs: [] });
    spy.removeLiquidity.mockResolvedValueOnce([{ __t: 1 }, { __t: 2 }, { __t: 3 }]);
    const { deps, sendTx } = makeDeps(sdk);
    await closePositionAt(deps, "PoolBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Pos1111111111111111111111111111111111111111", "oor");
    expect(sendTx).toHaveBeenCalledTimes(3);
  });
});
