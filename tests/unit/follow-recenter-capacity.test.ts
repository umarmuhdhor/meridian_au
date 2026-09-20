import { describe, it, expect } from "vitest";
import { detectRecenter, mirrorCapacity } from "../../src/domain/rules/follow-diff.js";
import { runFollowCycle } from "../../src/app/follow/cycle.js";
import { createRegistry } from "../../src/app/tools/registry.js";
import { createDryRunChainClient } from "../../src/adapters/chain/dry-run.js";
import { followDeployPositionTool } from "../../src/app/tools/impls/follow-deploy-position.js";
import { closePositionTool } from "../../src/app/tools/impls/close-position.js";
import { fixedClock } from "../../src/ports/clock.js";
import { makeCtx, memFollowRepo } from "./tool-context.js";
import type { AppConfig } from "../../src/domain/schemas/config.js";
import type { OnChainPosition } from "../../src/domain/schemas/chain.js";
import type { FollowedWallet, MirroredPosition } from "../../src/domain/schemas/follow-wallet.js";
import type { WalletWatcher, WatchedPosition } from "../../src/ports/wallet-watcher.js";

const CLOCK = fixedClock("2026-09-20T12:00:00.000Z");
const WHALE = "Whale1111111111111111111111111111111111111111";
const REGISTRY = createRegistry([followDeployPositionTool, closePositionTool]);

describe("detectRecenter", () => {
  const base = { recordedSourcePosition: null, recordedSourceLowerBin: 940, thresholdBins: 10 };

  it("no positions left = an exit, which the pool-set diff owns", () => {
    expect(detectRecenter({ ...base, current: [] }).recentered).toBe(false);
  });

  it("flags the copied position disappearing while they stay in the pool", () => {
    const v = detectRecenter({
      ...base,
      recordedSourcePosition: "theirOldPos",
      current: [{ position: "theirNewPos", lower_bin: 940 }],
    });
    expect(v.recentered).toBe(true);
    expect(v.reason).toContain("theirOld");
  });

  it("does not flag when the copied position is still open, even alongside others", () => {
    const v = detectRecenter({
      ...base,
      recordedSourcePosition: "theirPos",
      current: [
        { position: "theirPos", lower_bin: 940 },
        { position: "anotherPos", lower_bin: 700 },
      ],
    });
    expect(v.recentered).toBe(false);
  });

  it("falls back to bin drift when no position address was recorded", () => {
    const v = detectRecenter({ ...base, current: [{ position: null, lower_bin: 800 }] });
    expect(v.recentered).toBe(true);
    expect(v.reason).toContain("140 bins");
  });

  it("treats drift within the threshold as noise", () => {
    expect(
      detectRecenter({ ...base, current: [{ position: null, lower_bin: 935 }] }).recentered,
    ).toBe(false);
  });

  it("uses the CLOSEST position — one still near the old range means no move", () => {
    const v = detectRecenter({
      ...base,
      current: [
        { position: null, lower_bin: 300 },
        { position: null, lower_bin: 942 },
      ],
    });
    expect(v.recentered).toBe(false);
  });

  it("fails quiet on missing data rather than closing on a guess", () => {
    expect(
      detectRecenter({ ...base, recordedSourceLowerBin: null, current: [{ position: null, lower_bin: 1 }] })
        .recentered,
    ).toBe(false);
    expect(
      detectRecenter({ ...base, current: [{ position: null, lower_bin: null }] }).recentered,
    ).toBe(false);
  });
});

describe("mirrorCapacity", () => {
  it("returns the smaller of the portfolio and mirror allowances", () => {
    expect(
      mirrorCapacity({ ourOpenCount: 0, maxPositions: 3, openMirrorCount: 0, maxMirrored: 2 }),
    ).toEqual({ slots: 2, blockedBy: null });
    expect(
      mirrorCapacity({ ourOpenCount: 2, maxPositions: 3, openMirrorCount: 0, maxMirrored: 2 }),
    ).toEqual({ slots: 1, blockedBy: null });
  });

  it("names the mirror cap when it is the binding limit", () => {
    expect(
      mirrorCapacity({ ourOpenCount: 2, maxPositions: 5, openMirrorCount: 2, maxMirrored: 2 }),
    ).toEqual({ slots: 0, blockedBy: "max_mirrored" });
  });

  it("names the portfolio cap when it is the binding limit", () => {
    expect(
      mirrorCapacity({ ourOpenCount: 3, maxPositions: 3, openMirrorCount: 0, maxMirrored: 2 }),
    ).toEqual({ slots: 0, blockedBy: "max_positions" });
  });

  it("never returns negative slots when a cap has been exceeded", () => {
    expect(
      mirrorCapacity({ ourOpenCount: 9, maxPositions: 3, openMirrorCount: 9, maxMirrored: 2 }).slots,
    ).toBe(0);
  });
});

// ── integration through the cycle ────────────────────────────────────────────

function wallet(): FollowedWallet {
  return {
    address: WHALE,
    label: "friend",
    enabled: true,
    addedAt: "2026-09-19T00:00:00.000Z",
    sizePctOverride: null,
    notes: null,
  };
}

function mirror(over: Partial<MirroredPosition> = {}): MirroredPosition {
  return {
    position: "mirrorPos",
    pool: "poolA",
    pool_name: "TKN/SOL",
    base_mint: "MINT_A",
    source_wallet: WHALE,
    source_label: "friend",
    source_position: "theirOldPos",
    opened_at: "2026-09-20T09:00:00.000Z",
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
    ...over,
  };
}

function pos(over: Partial<OnChainPosition> = {}): OnChainPosition {
  return {
    position: "mirrorPos",
    pool: "poolA",
    pair: "TKN/SOL",
    base_mint: "MINT_A",
    lower_bin: 940,
    upper_bin: 1000,
    active_bin: 1000,
    in_range: true,
    unclaimed_fees_usd: 0,
    pnl_pct: 2,
    pnl_pct_suspicious: false,
    total_value_usd: 100,
    fee_per_tvl_24h: 10,
    age_minutes: 180,
    minutes_out_of_range: 0,
    ...over,
  };
}

function cfg(over: Record<string, unknown> = {}): AppConfig {
  const base = makeCtx({ clock: CLOCK }).config;
  return {
    ...base,
    follow: { ...base.follow, enabled: true, learnEnabled: false, ...over },
  } as AppConfig;
}

function watcherWith(pools: string[], inPool: WatchedPosition[]): WalletWatcher {
  return {
    async getOpenPools(w) {
      return { wallet: w, pools, positions: [], reliable: true };
    },
    async getPositionsInPool() {
      return inPool;
    },
  };
}

function theirPos(over: Partial<WatchedPosition> = {}): WatchedPosition {
  return {
    position: "theirOldPos",
    pool: "poolA",
    pool_name: "TKN/SOL",
    base_mint: "MINT_A",
    lower_bin: 940,
    upper_bin: 1000,
    deposit_sol: 50,
    pnl_pct: 3,
    ...over,
  };
}

describe("follow cycle — re-center", () => {
  function setup(config: AppConfig, inPool: WatchedPosition[]) {
    const chain = createDryRunChainClient({
      clock: CLOCK,
      seed: {
        walletSol: 5,
        positions: [pos()],
        activeBins: { poolA: { binId: 1000, price: 1, pricePerLamport: "1" } },
      },
    });
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [mirror()],
    });
    const ctx = makeCtx({ clock: CLOCK, chain, config, repos: { follow: repo } });
    return { ctx, repo, chain, watcher: watcherWith(["poolA"], inPool) };
  }

  it("closes our mirror when they re-center inside the same pool", async () => {
    const { ctx, repo, chain, watcher } = setup(cfg(), [theirPos({ position: "theirNewPos" })]);
    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher, repo });

    expect(r.recentered).toBe(1);
    expect(chain.peekPositions()).toHaveLength(0);
    const rec = (await repo.listMirrored())[0]!;
    expect(rec.close_reason).toContain("re-centered");
  });

  it("drops the pool from the baseline so the next tick re-mirrors it", async () => {
    const { ctx, repo, watcher } = setup(cfg(), [theirPos({ position: "theirNewPos" })]);
    await runFollowCycle({ ctx, registry: REGISTRY, watcher, repo });

    // poolA must NOT be remembered as seen, or the re-entry would never register.
    expect(await repo.getSeen(WHALE)).toEqual([]);
  });

  it("leaves the mirror alone when they have not moved", async () => {
    const { ctx, repo, chain, watcher } = setup(cfg(), [theirPos()]);
    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher, repo });

    expect(r.recentered).toBe(0);
    expect(chain.peekPositions()).toHaveLength(1);
    expect(await repo.getSeen(WHALE)).toEqual(["poolA"]);
  });

  it("does nothing when mirrorRecenter is off", async () => {
    const { ctx, repo, chain, watcher } = setup(cfg({ mirrorRecenter: false }), [
      theirPos({ position: "theirNewPos" }),
    ]);
    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher, repo });

    expect(r.recentered).toBe(0);
    expect(chain.peekPositions()).toHaveLength(1);
  });

  it("does not act on an unreliable snapshot", async () => {
    const { ctx, repo, chain } = setup(cfg(), [theirPos({ position: "theirNewPos" })]);
    const degraded: WalletWatcher = {
      async getOpenPools(w) {
        return { wallet: w, pools: ["poolA"], positions: [], reliable: false };
      },
      async getPositionsInPool() {
        return [theirPos({ position: "theirNewPos" })];
      },
    };
    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher: degraded, repo });

    expect(r.recentered).toBe(0);
    expect(chain.peekPositions()).toHaveLength(1);
  });
});

describe("follow cycle — maxMirrored cap", () => {
  it("stops opening once follow.maxMirrored is reached, leaving room for screening", async () => {
    const chain = createDryRunChainClient({
      clock: CLOCK,
      seed: {
        walletSol: 10,
        positions: [pos({ position: "m1", pool: "poolA" })],
        activeBins: {
          poolB: { binId: 2000, price: 1, pricePerLamport: "1" },
          poolC: { binId: 3000, price: 1, pricePerLamport: "1" },
        },
      },
    });
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [mirror({ position: "m1", source_position: "theirOldPos" })],
    });
    const ctx = makeCtx({
      clock: CLOCK,
      chain,
      // maxPositions 3, maxMirrored 2 → one mirror open, one slot left for follow,
      // and the third portfolio slot stays reserved for the screener.
      config: cfg({ maxMirrored: 2, mirrorRecenter: false }),
      repos: { follow: repo },
    });
    const watcher = watcherWith(["poolA", "poolB", "poolC"], [theirPos()]);

    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher, repo });

    expect(r.opened).toBe(1);
    expect(r.capped).toBe(1);
    expect((await repo.listOpenMirrored()).length).toBe(2);
    // Third slot untouched — screening can still deploy.
    expect(chain.peekPositions()).toHaveLength(2);
  });

  it("frees a slot in the same tick when a close precedes an open", async () => {
    const chain = createDryRunChainClient({
      clock: CLOCK,
      seed: {
        walletSol: 10,
        positions: [pos({ position: "m1", pool: "poolA" }), pos({ position: "m2", pool: "poolB" })],
        activeBins: { poolC: { binId: 3000, price: 1, pricePerLamport: "1" } },
      },
    });
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA", "poolB"] },
      seeded: [WHALE],
      mirrored: [
        mirror({ position: "m1", pool: "poolA" }),
        mirror({ position: "m2", pool: "poolB" }),
      ],
    });
    const ctx = makeCtx({
      clock: CLOCK,
      chain,
      config: cfg({ maxMirrored: 2, mirrorRecenter: false }),
      repos: { follow: repo },
    });
    // They left poolA and entered poolC — a rotation at the mirror cap.
    const watcher = watcherWith(["poolB", "poolC"], [theirPos()]);

    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher, repo });

    expect(r.closed).toBe(1);
    expect(r.opened).toBe(1);
    expect(r.capped).toBe(0);
  });
});
