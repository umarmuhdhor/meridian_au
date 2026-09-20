import { describe, it, expect } from "vitest";
import {
  createMeteoraWalletWatcher,
  type FetchImpl,
} from "../../src/adapters/market/meteora-wallet-watcher.js";
import { parseRetrospective } from "../../src/app/follow/learn.js";
import { nullLogger } from "../../src/ports/logger.js";

function fetchStub(routes: Record<string, unknown>, fail: string[] = []): FetchImpl {
  return async (url) => {
    if (fail.some((f) => url.includes(f))) {
      return {
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => ({}),
        text: async () => "",
      };
    }
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : {};
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

const W = "Whale111";

describe("createMeteoraWalletWatcher.getOpenPools", () => {
  it("collects pool addresses and reports the snapshot reliable", async () => {
    const watcher = createMeteoraWalletWatcher({
      logger: nullLogger,
      fetchImpl: fetchStub({
        "portfolio/open": {
          pools: [{ poolAddress: "poolA" }, { poolAddress: "poolB" }],
          hasNext: false,
        },
      }),
    });
    const snap = await watcher.getOpenPools(W);
    expect(snap.pools).toEqual(["poolA", "poolB"]);
    expect(snap.reliable).toBe(true);
  });

  it("marks the snapshot unreliable when datapi errors", async () => {
    const watcher = createMeteoraWalletWatcher({
      logger: nullLogger,
      fetchImpl: fetchStub({}, ["portfolio/open"]),
    });
    const snap = await watcher.getOpenPools(W);
    expect(snap.reliable).toBe(false);
    expect(snap.pools).toEqual([]);
  });

  it("marks the snapshot unreliable when the body does not match the schema", async () => {
    const watcher = createMeteoraWalletWatcher({
      logger: nullLogger,
      fetchImpl: fetchStub({ "portfolio/open": { pools: [{ notAnAddress: 1 }] } }),
    });
    const snap = await watcher.getOpenPools(W);
    expect(snap.reliable).toBe(false);
  });

  it("returns an empty reliable snapshot for a wallet with no open positions", async () => {
    const watcher = createMeteoraWalletWatcher({
      logger: nullLogger,
      fetchImpl: fetchStub({ "portfolio/open": { pools: [], hasNext: false } }),
    });
    const snap = await watcher.getOpenPools(W);
    expect(snap.pools).toEqual([]);
    expect(snap.reliable).toBe(true);
  });

  it("de-duplicates a pool that appears on more than one page", async () => {
    let call = 0;
    const watcher = createMeteoraWalletWatcher({
      logger: nullLogger,
      fetchImpl: async () => {
        call++;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            pools: [{ poolAddress: "poolA" }],
            hasNext: call < 2,
          }),
          text: async () => "",
        };
      },
    });
    const snap = await watcher.getOpenPools(W);
    expect(snap.pools).toEqual(["poolA"]);
  });
});

describe("createMeteoraWalletWatcher.getPositionsInPool", () => {
  it("normalizes bin range, deposit and PnL", async () => {
    const watcher = createMeteoraWalletWatcher({
      logger: nullLogger,
      fetchImpl: fetchStub({
        "/pnl": {
          positions: [
            {
              positionAddress: "theirPos",
              lowerBinId: 940,
              upperBinId: 1000,
              pnlSolPctChange: "12.5",
              allTimeDeposits: { total: { sol: "50" } },
            },
          ],
        },
      }),
    });
    const rows = await watcher.getPositionsInPool(W, "poolA");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      position: "theirPos",
      pool: "poolA",
      lower_bin: 940,
      upper_bin: 1000,
      deposit_sol: 50,
      pnl_pct: 12.5,
    });
  });

  it("returns an empty list on an upstream error rather than throwing", async () => {
    const watcher = createMeteoraWalletWatcher({
      logger: nullLogger,
      fetchImpl: fetchStub({}, ["/pnl"]),
    });
    await expect(watcher.getPositionsInPool(W, "poolA")).resolves.toEqual([]);
  });
});

describe("parseRetrospective", () => {
  it("extracts the three labelled lines", () => {
    const out = parseRetrospective(
      "ENTRY: bought a reclaim of the 1h support\nEXIT: closed after a 4-candle red streak\nLESSON: PREFER this wallet's entries that sit within 5% of 1h support",
    );
    expect(out.entry).toContain("reclaim");
    expect(out.exit).toContain("red streak");
    expect(out.rule).toContain("PREFER");
  });

  it("tolerates surrounding prose and missing labels", () => {
    const out = parseRetrospective("Here is my read.\nLESSON: AVOID mirroring after a 3x spike");
    expect(out.entry).toBeNull();
    expect(out.exit).toBeNull();
    expect(out.rule).toBe("AVOID mirroring after a 3x spike");
  });

  it("returns nulls for an unparseable reply", () => {
    expect(parseRetrospective("I cannot tell.")).toEqual({
      entry: null,
      exit: null,
      rule: null,
    });
  });
});
