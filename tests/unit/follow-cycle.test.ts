import { describe, it, expect } from "vitest";
import { runFollowCycle } from "../../src/app/follow/cycle.js";
import { createRegistry } from "../../src/app/tools/registry.js";
import { createDryRunChainClient } from "../../src/adapters/chain/dry-run.js";
import { fixedClock } from "../../src/ports/clock.js";
import { followDeployPositionTool } from "../../src/app/tools/impls/follow-deploy-position.js";
import { closePositionTool } from "../../src/app/tools/impls/close-position.js";
import { makeCtx, memFollowRepo } from "./tool-context.js";
import type { AppConfig } from "../../src/domain/schemas/config.js";
import type { FollowedWallet } from "../../src/domain/schemas/follow-wallet.js";
import type { WalletWatcher, WatchedPosition } from "../../src/ports/wallet-watcher.js";
import type { OnChainPosition } from "../../src/domain/schemas/chain.js";

const CLOCK = fixedClock("2026-09-20T12:00:00.000Z");
const WHALE = "Whale1111111111111111111111111111111111111111";
const REGISTRY = createRegistry([followDeployPositionTool, closePositionTool]);

function wallet(over: Partial<FollowedWallet> = {}): FollowedWallet {
  return {
    address: WHALE,
    label: "whale",
    enabled: true,
    addedAt: "2026-09-19T00:00:00.000Z",
    sizePctOverride: null,
    notes: null,
    ...over,
  };
}

/** Watcher double — `pools` drives the diff, `detail` drives the mirrored range. */
function fakeWatcher(
  pools: string[],
  detail: Partial<WatchedPosition> = {},
  reliable = true,
): WalletWatcher {
  return {
    async getOpenPools(w) {
      return {
        wallet: w,
        pools,
        positions: pools.map((p) => ({
          position: null,
          pool: p,
          pool_name: null,
          base_mint: null,
          lower_bin: null,
          upper_bin: null,
          deposit_sol: null,
          pnl_pct: null,
        })),
        reliable,
      };
    },
    async getPositionsInPool(_w, pool) {
      return [
        {
          position: "their-pos",
          pool,
          pool_name: "TKN/SOL",
          base_mint: "MINT_A",
          lower_bin: 940,
          upper_bin: 1000,
          deposit_sol: 50,
          pnl_pct: 12.5,
          ...detail,
        },
      ];
    },
  };
}

function cfgWith(followOver: Record<string, unknown> = {}): AppConfig {
  const base = makeCtx({ clock: CLOCK }).config;
  return {
    ...base,
    follow: { ...base.follow, enabled: true, learnEnabled: false, ...followOver },
  } as AppConfig;
}

function chainWith(positions: OnChainPosition[] = [], walletSol = 5) {
  return createDryRunChainClient({
    clock: CLOCK,
    seed: {
      walletSol,
      positions,
      activeBins: {
        poolA: { binId: 1000, price: 1, pricePerLamport: "1" },
        poolB: { binId: 2000, price: 1, pricePerLamport: "1" },
      },
    },
  });
}

function openPosition(over: Partial<OnChainPosition> = {}): OnChainPosition {
  return {
    position: "dry-run-pos-1",
    pool: "poolA",
    pair: "TKN/SOL",
    base_mint: "MINT_A",
    lower_bin: 940,
    upper_bin: 1000,
    active_bin: 1000,
    in_range: true,
    unclaimed_fees_usd: 0,
    pnl_pct: 3,
    pnl_pct_suspicious: false,
    total_value_usd: 100,
    fee_per_tvl_24h: 10,
    age_minutes: 60,
    minutes_out_of_range: 0,
    ...over,
  };
}

describe("runFollowCycle", () => {
  it("is a no-op when follow is globally disabled", async () => {
    const ctx = makeCtx({ clock: CLOCK });
    const repo = memFollowRepo({ wallets: [wallet()] });
    const r = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: fakeWatcher(["poolA"]),
      repo,
    });
    expect(r.kind).toBe("disabled");
    expect(await repo.listMirrored()).toEqual([]);
  });

  it("seeds on first sight without mirroring anything", async () => {
    const repo = memFollowRepo({ wallets: [wallet()] });
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain: chainWith() });
    const r = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: fakeWatcher(["poolA", "poolB"]),
      repo,
    });
    expect(r.seeded).toEqual([WHALE]);
    expect(r.opened).toBe(0);
    expect(await repo.listMirrored()).toEqual([]);
    expect(await repo.getSeen(WHALE)).toEqual(["poolA", "poolB"]);
  });

  it("mirrors a new entry on the tick after seeding", async () => {
    const repo = memFollowRepo({ wallets: [wallet()], seen: { [WHALE]: [] }, seeded: [WHALE] });
    const chain = chainWith();
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain });
    const r = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: fakeWatcher(["poolA"]),
      repo,
    });
    expect(r.opened).toBe(1);
    const mirrors = await repo.listMirrored();
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]!.pool).toBe("poolA");
    expect(mirrors[0]!.source_wallet).toBe(WHALE);
    // 5 SOL − 0.25 gasReserve = 4.75 free × 35% = 1.6625, clamped to maxDeploySol 1.
    expect(mirrors[0]!.amount_sol).toBe(1);
    expect(chain.peekPositions()).toHaveLength(1);
  });

  it("copies the followed wallet's depth below the active bin", async () => {
    const repo = memFollowRepo({ wallets: [wallet()], seen: { [WHALE]: [] }, seeded: [WHALE] });
    const chain = chainWith();
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain });
    // active 1000, their lower 940 → 60 bins below.
    await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: fakeWatcher(["poolA"], { lower_bin: 940 }),
      repo,
    });
    const deployed = chain.peekPositions()[0]!;
    expect(deployed.lower_bin).toBe(940);
    expect(deployed.upper_bin).toBe(1000);
    const mirror = (await repo.listMirrored())[0]!;
    expect(mirror.source_lower_bin).toBe(940);
  });

  it("mirrors a range narrower than the 35-bin screener floor", async () => {
    const repo = memFollowRepo({ wallets: [wallet()], seen: { [WHALE]: [] }, seeded: [WHALE] });
    const chain = chainWith();
    const ctx = makeCtx({
      clock: CLOCK,
      config: cfgWith({ minBinsBelow: 5 }),
      chain,
    });
    await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: fakeWatcher(["poolA"], { lower_bin: 990 }),
      repo,
    });
    const deployed = chain.peekPositions()[0]!;
    expect(deployed.lower_bin).toBe(990);
    expect(deployed.upper_bin).toBe(1000);
  });

  it("closes our mirror when the followed wallet exits", async () => {
    const chain = chainWith([openPosition()]);
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [
        {
          position: "dry-run-pos-1",
          pool: "poolA",
          pool_name: "TKN/SOL",
          base_mint: "MINT_A",
          source_wallet: WHALE,
          source_label: "whale",
          source_position: null,
          opened_at: "2026-09-20T10:00:00.000Z",
          closed_at: null,
          close_reason: null,
          amount_sol: 1,
          lower_bin: 940,
          upper_bin: 1000,
          source_lower_bin: 940,
          source_upper_bin: 1000,
          source_deposit_sol: 50,
          entry_technicals: null,
          entry_context: null,
          exit_technicals: null,
          exit_context: null,
          source_pnl_pct: null,
          lesson_id: null,
        },
      ],
    });
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain });
    const r = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: fakeWatcher([]),
      repo,
    });
    expect(r.closed).toBe(1);
    expect(chain.peekPositions()).toHaveLength(0);
    const rec = (await repo.listMirrored())[0]!;
    expect(rec.closed_at).toBe("2026-09-20T12:00:00.000Z");
    expect(rec.close_reason).toContain("whale exited");
  });

  it("does NOT close on an unreliable snapshot", async () => {
    const chain = chainWith([openPosition()]);
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [
        {
          position: "dry-run-pos-1",
          pool: "poolA",
          pool_name: null,
          base_mint: null,
          source_wallet: WHALE,
          source_label: "whale",
          source_position: null,
          opened_at: "2026-09-20T10:00:00.000Z",
          closed_at: null,
          close_reason: null,
          amount_sol: 1,
          lower_bin: null,
          upper_bin: null,
          source_lower_bin: null,
          source_upper_bin: null,
          source_deposit_sol: null,
          entry_technicals: null,
          entry_context: null,
          exit_technicals: null,
          exit_context: null,
          source_pnl_pct: null,
          lesson_id: null,
        },
      ],
    });
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain });
    const r = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: fakeWatcher([], {}, false),
      repo,
    });
    expect(r.closed).toBe(0);
    expect(chain.peekPositions()).toHaveLength(1);
    // The degraded snapshot must not become the baseline.
    expect(await repo.getSeen(WHALE)).toEqual(["poolA"]);
  });

  it("skips a disabled wallet", async () => {
    const repo = memFollowRepo({
      wallets: [wallet({ enabled: false })],
      seen: { [WHALE]: [] },
      seeded: [WHALE],
    });
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain: chainWith() });
    const r = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: fakeWatcher(["poolA"]),
      repo,
    });
    expect(r.kind).toBe("no_wallets");
    expect(await repo.listMirrored()).toEqual([]);
  });

  it("still enforces maxPositions — capped before the write is attempted", async () => {
    const full = [
      openPosition({ position: "p1", pool: "poolX" }),
      openPosition({ position: "p2", pool: "poolY" }),
      openPosition({ position: "p3", pool: "poolZ" }),
    ];
    const chain = chainWith(full);
    const repo = memFollowRepo({ wallets: [wallet()], seen: { [WHALE]: [] }, seeded: [WHALE] });
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain });
    const r = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: fakeWatcher(["poolA"]),
      repo,
    });
    expect(r.opened).toBe(0);
    // The capacity check now rejects it up front, so no deploy is attempted and this
    // is not counted as a failure — but `maxPositionsGate` remains the backstop.
    expect(r.capped).toBe(1);
    expect(r.failures).toBe(0);
    expect(await repo.listMirrored()).toEqual([]);
  });

  it("skips a pool we are already in", async () => {
    const chain = chainWith([openPosition({ position: "p1", pool: "poolA" })]);
    const repo = memFollowRepo({ wallets: [wallet()], seen: { [WHALE]: [] }, seeded: [WHALE] });
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain });
    const r = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: fakeWatcher(["poolA"]),
      repo,
    });
    expect(r.opened).toBe(0);
    expect(r.failures).toBe(0);
  });

  it("does not re-mirror the same pool on the next tick", async () => {
    const repo = memFollowRepo({ wallets: [wallet()], seen: { [WHALE]: [] }, seeded: [WHALE] });
    const chain = chainWith();
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain });
    const deps = { ctx, registry: REGISTRY, watcher: fakeWatcher(["poolA"]), repo };
    await runFollowCycle(deps);
    const second = await runFollowCycle(deps);
    expect(second.opened).toBe(0);
    expect(chain.peekPositions()).toHaveLength(1);
  });
});

/**
 * A mirror we cannot read is a mirror we cannot copy.
 *
 * `getPositionsInPool` answers `null` for a failed read and `[]` for a pool they
 * genuinely hold nothing in. Collapsing the two would open the position at a guessed
 * fallback range with no record of theirs — and since re-center detection keys on their
 * position address and lower bin, that mirror could never detect a re-center again.
 */
describe("follow cycle — an unreadable source position", () => {
  /** Watcher whose pool list works but whose position detail fails. */
  function blindWatcher(pools: string[]): WalletWatcher {
    return {
      async getOpenPools(w) {
        return { wallet: w, pools, positions: [], reliable: true };
      },
      async getPositionsInPool() {
        return null;
      },
    };
  }

  function emptyPoolWatcher(pools: string[]): WalletWatcher {
    return {
      async getOpenPools(w) {
        return { wallet: w, pools, positions: [], reliable: true };
      },
      async getPositionsInPool() {
        return [];
      },
    };
  }

  it("does not deploy when their position cannot be read", async () => {
    const chain = chainWith();
    const repo = memFollowRepo({ wallets: [wallet()], seen: { [WHALE]: [] }, seeded: [WHALE] });
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain });

    const r = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: blindWatcher(["poolA"]),
      repo,
    });

    expect(r.opened).toBe(0);
    expect(r.failures).toBe(1);
    expect(chain.peekPositions()).toHaveLength(0);
  });

  it("withholds the pool from the baseline so the next tick tries again", async () => {
    const chain = chainWith();
    const repo = memFollowRepo({ wallets: [wallet()], seen: { [WHALE]: [] }, seeded: [WHALE] });
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain });

    await runFollowCycle({ ctx, registry: REGISTRY, watcher: blindWatcher(["poolA"]), repo });
    // Remembering poolA here would mean a transient datapi blip permanently costs us
    // this entry — the diff would never see it as new again.
    expect(await repo.getSeen(WHALE)).toEqual([]);

    // datapi recovers.
    const second = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: fakeWatcher(["poolA"]),
      repo,
    });

    expect(second.opened).toBe(1);
    expect(chain.peekPositions()).toHaveLength(1);
  });

  it("mirrors their real range once the read succeeds, not the fallback width", async () => {
    const chain = chainWith();
    const repo = memFollowRepo({ wallets: [wallet()], seen: { [WHALE]: [] }, seeded: [WHALE] });
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain });

    await runFollowCycle({
      ctx,
      registry: REGISTRY,
      // active bin 1000, their lower bin 940 → 60 bins below, not fallbackBinsBelow 55.
      watcher: fakeWatcher(["poolA"], { position: "theirPos", lower_bin: 940 }),
      repo,
    });

    const rec = (await repo.listOpenMirrored())[0]!;
    expect(rec.source_position).toBe("theirPos");
    expect(rec.source_lower_bin).toBe(940);
    // Populated source fields are what keeps re-center detection alive for this mirror.
    expect(rec.entry_context?.range_source).toBe("mirrored");
  });

  it("advances the baseline when they genuinely hold nothing there", async () => {
    // A successful read of an empty pool is a decision, not a failure: they left
    // between the two polls. Nothing to copy, and no reason to keep re-checking.
    const chain = chainWith();
    const repo = memFollowRepo({ wallets: [wallet()], seen: { [WHALE]: [] }, seeded: [WHALE] });
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith(), chain });

    const r = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: emptyPoolWatcher(["poolA"]),
      repo,
    });

    expect(r.opened).toBe(0);
    expect(chain.peekPositions()).toHaveLength(0);
    expect(await repo.getSeen(WHALE)).toEqual(["poolA"]);
  });

  it("skips the re-center check rather than closing when their position cannot be read", async () => {
    const chain = chainWith([openPosition({ position: "m1", pool: "poolA" })]);
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [
        {
          position: "m1",
          pool: "poolA",
          pool_name: null,
          base_mint: null,
          source_wallet: WHALE,
          source_label: "whale",
          source_position: "theirPos",
          opened_at: "2026-09-19T00:00:00.000Z",
          closed_at: null,
          close_reason: null,
          amount_sol: 1,
          lower_bin: 940,
          upper_bin: 1000,
          source_lower_bin: 940,
          source_upper_bin: 1000,
          source_deposit_sol: 50,
          entry_technicals: null,
          entry_context: null,
          exit_technicals: null,
          exit_context: null,
          source_pnl_pct: null,
          lesson_id: null,
        },
      ],
    });
    const ctx = makeCtx({ clock: CLOCK, config: cfgWith({ mirrorRecenter: true }), chain });

    const r = await runFollowCycle({
      ctx,
      registry: REGISTRY,
      watcher: blindWatcher(["poolA"]),
      repo,
    });

    // A failed read would otherwise look exactly like "their position is gone", and
    // closing on it costs real fees for a re-center we have no evidence of.
    expect(r.recentered).toBe(0);
    expect(chain.peekPositions()).toHaveLength(1);
  });
});
