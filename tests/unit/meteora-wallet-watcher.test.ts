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

  /**
   * A pool list that is INCOMPLETE but reported reliable is the mass-false-exit case:
   * the diff reads every pool it cannot see as an exit and closes those mirrors. So the
   * snapshot is trusted only when a page positively says it is the last one.
   */
  describe("truncation", () => {
    /** Serves `pages` in order, then repeats the final page. */
    function paged(pages: unknown[]): FetchImpl {
      let i = 0;
      return async () => {
        const body = pages[Math.min(i++, pages.length - 1)];
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      };
    }

    const fullPage = (tag: string, hasNext?: boolean | null) => ({
      pools: Array.from({ length: 50 }, (_, n) => ({ poolAddress: `${tag}-${n}` })),
      ...(hasNext === undefined ? {} : { hasNext }),
    });

    it("is unreliable when every page still claims there is another", async () => {
      // The page cap runs out before the list ends — we are holding a prefix, not a set.
      const watcher = createMeteoraWalletWatcher({
        logger: nullLogger,
        fetchImpl: paged([fullPage("p", true)]),
      });
      const snap = await watcher.getOpenPools(W);
      expect(snap.reliable).toBe(false);
    });

    it("is unreliable when a full page carries no continuation signal at all", async () => {
      // `hasNext` gone from the response (renamed upstream) plus a full page: we cannot
      // tell the end of the list from the start of a silent truncation.
      const watcher = createMeteoraWalletWatcher({
        logger: nullLogger,
        fetchImpl: paged([fullPage("p")]),
      });
      const snap = await watcher.getOpenPools(W);
      expect(snap.reliable).toBe(false);
    });

    it("trusts hasNext:false even on a page that happens to be full", async () => {
      // A wallet holding exactly PAGE_SIZE pools must not be permanently unreliable —
      // that would suppress its exits forever, which is its own way of stranding mirrors.
      const watcher = createMeteoraWalletWatcher({
        logger: nullLogger,
        fetchImpl: paged([fullPage("p", false)]),
      });
      const snap = await watcher.getOpenPools(W);
      expect(snap.reliable).toBe(true);
      expect(snap.pools).toHaveLength(50);
    });

    it("trusts a short page even with no continuation signal", async () => {
      const watcher = createMeteoraWalletWatcher({
        logger: nullLogger,
        fetchImpl: paged([{ pools: [{ poolAddress: "poolA" }] }]),
      });
      const snap = await watcher.getOpenPools(W);
      expect(snap.reliable).toBe(true);
      expect(snap.pools).toEqual(["poolA"]);
    });

    it("keeps paging past a full unsignalled page and ends on the short one", async () => {
      const watcher = createMeteoraWalletWatcher({
        logger: nullLogger,
        fetchImpl: paged([fullPage("a"), { pools: [{ poolAddress: "tail" }] }]),
      });
      const snap = await watcher.getOpenPools(W);
      expect(snap.reliable).toBe(true);
      expect(snap.pools).toHaveLength(51);
    });

    it("treats hasNext:null the same as absent", async () => {
      const watcher = createMeteoraWalletWatcher({
        logger: nullLogger,
        fetchImpl: paged([fullPage("p", null)]),
      });
      const snap = await watcher.getOpenPools(W);
      expect(snap.reliable).toBe(false);
    });
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

  it("returns null on an upstream error — distinct from an empty pool", async () => {
    const watcher = createMeteoraWalletWatcher({
      logger: nullLogger,
      fetchImpl: fetchStub({}, ["/pnl"]),
    });
    // null, not [] — the follow cycle defers a mirror it cannot read rather than
    // opening one at a guessed range, and it can only tell the two apart here.
    await expect(watcher.getPositionsInPool(W, "poolA")).resolves.toBeNull();
  });

  it("returns null when the body does not match the schema", async () => {
    const watcher = createMeteoraWalletWatcher({
      logger: nullLogger,
      fetchImpl: fetchStub({ "/pnl": { positions: [{ lowerBinId: "not-a-number" }] } }),
    });
    await expect(watcher.getPositionsInPool(W, "poolA")).resolves.toBeNull();
  });

  it("returns an empty array when they genuinely hold nothing in the pool", async () => {
    const watcher = createMeteoraWalletWatcher({
      logger: nullLogger,
      fetchImpl: fetchStub({ "/pnl": { positions: [] } }),
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
