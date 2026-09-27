import { describe, it, expect, vi } from "vitest";
import { nullLogger } from "../../src/ports/logger.js";
import {
  createMeteoraDatapiPnlFetcher,
  DatapiPositionSchema,
  deriveOpenPnlPct,
  normalizeDatapiPosition,
  type FetchImpl,
  type DatapiPnlRecord,
} from "../../src/adapters/chain/meteora/datapi-pnl.js";

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<FetchImpl>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const POOL = "PoolAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET = "WalletBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function fixtureRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    positionAddress: "Pos1111111111111111111111111111111111111111",
    lowerBinId: 100,
    upperBinId: 200,
    poolActiveBinId: 150,
    isOutOfRange: false,
    pnlPctChange: "3.5",
    pnlSolPctChange: "2.1",
    allTimeDeposits: { total: { usd: "1000", sol: "6.5" } },
    allTimeWithdrawals: { total: { usd: "0", sol: "0" } },
    allTimeFees: { total: { usd: "12.34", sol: "0.08" } },
    unrealizedPnl: {
      balances: "1020",
      balancesSol: "6.7",
      unclaimedFeeTokenX: { usd: "5", amountSol: "0.03" },
      unclaimedFeeTokenY: { usd: "3", amountSol: "0.02" },
    },
    ...overrides,
  };
}

describe("normalizeDatapiPosition", () => {
  it("normalizes a full row into DatapiPnlRecord", () => {
    const parsed = DatapiPositionSchema.parse(fixtureRow());
    const rec = normalizeDatapiPosition(parsed);
    expect(rec).not.toBeNull();
    expect(rec?.positionAddress).toBe("Pos1111111111111111111111111111111111111111");
    expect(rec?.reportedPctUsd).toBe(3.5);
    expect(rec?.reportedPctSol).toBe(2.1);
    expect(rec?.balancesUsd).toBe(1020);
    expect(rec?.balancesSol).toBe(6.7);
    expect(rec?.unclaimedFeeUsd).toBe(8);
    expect(rec?.unclaimedFeeSol).toBeCloseTo(0.05);
    expect(rec?.depositUsd).toBe(1000);
    expect(rec?.depositSol).toBe(6.5);
    expect(rec?.feesUsd).toBe(12.34);
  });

  it("returns null when no position address present", () => {
    const parsed = DatapiPositionSchema.parse({});
    expect(normalizeDatapiPosition(parsed)).toBeNull();
  });
});

describe("deriveOpenPnlPct", () => {
  it("mirrors tools/dlmm.js:1078 formula (USD)", () => {
    const rec: DatapiPnlRecord = {
      positionAddress: "P1",
      lowerBinId: 0,
      upperBinId: 0,
      poolActiveBinId: 0,
      isOutOfRange: null,
      reportedPctUsd: null,
      reportedPctSol: null,
      balancesUsd: 1020,
      balancesSol: null,
      unclaimedFeeUsd: 8,
      unclaimedFeeSol: 0,
      depositUsd: 1000,
      depositSol: null,
      withdrawalsUsd: 0,
      withdrawalsSol: 0,
      feesUsd: 12,
      feesSol: 0,
    };
    // (1020 + 8 + 0 + 12 - 1000) / 1000 * 100 = 4%
    expect(deriveOpenPnlPct(rec, false)).toBeCloseTo(4);
  });

  it("returns null when deposit missing or zero", () => {
    const rec: DatapiPnlRecord = {
      positionAddress: "P1",
      lowerBinId: 0,
      upperBinId: 0,
      poolActiveBinId: 0,
      isOutOfRange: null,
      reportedPctUsd: null,
      reportedPctSol: null,
      balancesUsd: 100,
      balancesSol: null,
      unclaimedFeeUsd: 0,
      unclaimedFeeSol: 0,
      depositUsd: 0,
      depositSol: null,
      withdrawalsUsd: 0,
      withdrawalsSol: 0,
      feesUsd: 0,
      feesSol: 0,
    };
    expect(deriveOpenPnlPct(rec, false)).toBeNull();
  });

  it("switches to SOL fields in solMode", () => {
    const rec: DatapiPnlRecord = {
      positionAddress: "P1",
      lowerBinId: 0,
      upperBinId: 0,
      poolActiveBinId: 0,
      isOutOfRange: null,
      reportedPctUsd: null,
      reportedPctSol: null,
      balancesUsd: null,
      balancesSol: 6.7,
      unclaimedFeeUsd: 0,
      unclaimedFeeSol: 0.05,
      depositUsd: null,
      depositSol: 6.5,
      withdrawalsUsd: 0,
      withdrawalsSol: 0,
      feesUsd: 0,
      feesSol: 0.08,
    };
    // (6.7 + 0.05 + 0 + 0.08 - 6.5) / 6.5 * 100 ≈ 5.08%
    const pct = deriveOpenPnlPct(rec, true);
    expect(pct).not.toBeNull();
    expect(pct as number).toBeCloseTo(5.077, 2);
  });
});

describe("createMeteoraDatapiPnlFetcher", () => {
  it("hits the /pnl endpoint and returns a Map keyed by position", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async (url: string) => {
      expect(url).toContain(`/${POOL}/pnl?user=${WALLET}`);
      expect(url).toContain("status=open");
      return jsonResponse({ positions: [fixtureRow()] });
    });
    const fetcher = createMeteoraDatapiPnlFetcher({ logger: nullLogger, fetchImpl });
    const map = await fetcher(POOL, WALLET);
    expect(map.size).toBe(1);
    const rec = map.get("Pos1111111111111111111111111111111111111111");
    expect(rec?.reportedPctUsd).toBe(3.5);
  });

  it("returns empty Map on non-2xx (logs, does not throw)", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ error: "nope" }, 500));
    const fetcher = createMeteoraDatapiPnlFetcher({ logger: nullLogger, fetchImpl });
    const map = await fetcher(POOL, WALLET);
    expect(map.size).toBe(0);
  });

  it("returns empty Map when fetch throws", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      throw new Error("network down");
    });
    const fetcher = createMeteoraDatapiPnlFetcher({ logger: nullLogger, fetchImpl });
    const map = await fetcher(POOL, WALLET);
    expect(map.size).toBe(0);
  });

  it("queries status=open by default and status=closed via .closed", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ positions: [fixtureRow()] }));
    const fetcher = createMeteoraDatapiPnlFetcher({ logger: nullLogger, fetchImpl });
    await fetcher(POOL, WALLET);
    const closed = await fetcher.closed!(POOL, WALLET);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("status=open");
    expect(fetchImpl.mock.calls[1]?.[0]).toContain("status=closed");
    expect(closed.get("Pos1111111111111111111111111111111111111111")?.feesUsd).toBe(12.34);
  });

  it("handles `data` array shape as well as `positions`", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ data: [fixtureRow()] }));
    const fetcher = createMeteoraDatapiPnlFetcher({ logger: nullLogger, fetchImpl });
    const map = await fetcher(POOL, WALLET);
    expect(map.size).toBe(1);
  });
});
