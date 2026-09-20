import { describe, it, expect } from "vitest";
import {
  diffFollowedWallet,
  planMirrorRange,
  planMirrorSize,
} from "../../src/domain/rules/follow-diff.js";
import type { MirroredPosition } from "../../src/domain/schemas/follow-wallet.js";
import type { WatchedWalletSnapshot } from "../../src/ports/wallet-watcher.js";

function snap(pools: string[], reliable = true): WatchedWalletSnapshot {
  return {
    wallet: "W",
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
}

function mirror(pool: string, position = `pos-${pool}`): MirroredPosition {
  return {
    position,
    pool,
    pool_name: null,
    base_mint: null,
    source_wallet: "W",
    source_label: "whale",
    source_position: null,
    opened_at: "2026-09-20T00:00:00.000Z",
    closed_at: null,
    close_reason: null,
    amount_sol: 0.4,
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
  };
}

describe("diffFollowedWallet", () => {
  it("first sight seeds and mirrors nothing", () => {
    const d = diffFollowedWallet({
      seen: null,
      snapshot: snap(["poolA", "poolB"]),
      ourOpenPools: [],
      openMirrors: [],
    });
    expect(d.seedOnly).toBe(true);
    expect(d.opens).toEqual([]);
    expect(d.closes).toEqual([]);
    expect(d.nextSeen).toEqual(["poolA", "poolB"]);
  });

  it("detects a new pool as an open", () => {
    const d = diffFollowedWallet({
      seen: ["poolA"],
      snapshot: snap(["poolA", "poolB"]),
      ourOpenPools: [],
      openMirrors: [],
    });
    expect(d.seedOnly).toBe(false);
    expect(d.opens).toEqual(["poolB"]);
    expect(d.closes).toEqual([]);
  });

  it("detects a vanished pool as a close of our mirror", () => {
    const m = mirror("poolA");
    const d = diffFollowedWallet({
      seen: ["poolA", "poolB"],
      snapshot: snap(["poolB"]),
      ourOpenPools: ["poolA"],
      openMirrors: [m],
    });
    expect(d.closes.map((c) => c.position)).toEqual(["pos-poolA"]);
    expect(d.opens).toEqual([]);
  });

  it("suppresses closes when the snapshot is unreliable but still allows opens", () => {
    const m = mirror("poolA");
    const d = diffFollowedWallet({
      seen: ["poolA"],
      snapshot: snap(["poolB"], false),
      ourOpenPools: ["poolA"],
      openMirrors: [m],
    });
    expect(d.closes).toEqual([]);
    expect(d.closesSuppressed).toBe(true);
    expect(d.opens).toEqual(["poolB"]);
  });

  it("does not advance the baseline on an unreliable snapshot", () => {
    const d = diffFollowedWallet({
      seen: ["poolA"],
      snapshot: snap(["poolB"], false),
      ourOpenPools: [],
      openMirrors: [],
    });
    expect(d.nextSeen).toBeNull();
  });

  it("skips a pool we already hold from another source", () => {
    const d = diffFollowedWallet({
      seen: ["poolA"],
      snapshot: snap(["poolA", "poolB"]),
      ourOpenPools: ["poolB"],
      openMirrors: [],
    });
    expect(d.opens).toEqual([]);
    expect(d.skipped).toEqual([{ pool: "poolB", reason: "already_open" }]);
  });

  it("skips a pool we already mirror from this wallet", () => {
    const d = diffFollowedWallet({
      seen: ["poolA"],
      snapshot: snap(["poolA", "poolB"]),
      ourOpenPools: [],
      openMirrors: [mirror("poolB")],
    });
    expect(d.opens).toEqual([]);
    expect(d.skipped).toEqual([{ pool: "poolB", reason: "already_mirrored" }]);
  });

  it("handles a rotation — one close and one open in the same tick", () => {
    const d = diffFollowedWallet({
      seen: ["poolA"],
      snapshot: snap(["poolB"]),
      ourOpenPools: ["poolA"],
      openMirrors: [mirror("poolA")],
    });
    expect(d.opens).toEqual(["poolB"]);
    expect(d.closes.map((c) => c.pool)).toEqual(["poolA"]);
  });
});

describe("planMirrorSize", () => {
  const base = { sizePct: 0.5, gasReserve: 0.25, minDeploySol: 0.05, maxDeploySol: 1 };

  it("takes the percentage of SOL free after the gas reserve", () => {
    const r = planMirrorSize({ ...base, walletSol: 2.25 });
    expect(r).toEqual({ ok: true, amountSol: 1 });
  });

  it("clamps to maxDeploySol", () => {
    const r = planMirrorSize({ ...base, walletSol: 10 });
    expect(r.ok && r.amountSol).toBe(1);
  });

  it("refuses when the result is under minDeploySol", () => {
    const r = planMirrorSize({ ...base, walletSol: 0.3 });
    expect(r.ok).toBe(false);
  });

  it("refuses when the balance is at or under the gas reserve", () => {
    const r = planMirrorSize({ ...base, walletSol: 0.25 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("gasReserve");
  });

  it("refuses a zero or unreadable balance", () => {
    expect(planMirrorSize({ ...base, walletSol: 0 }).ok).toBe(false);
    expect(planMirrorSize({ ...base, walletSol: Number.NaN }).ok).toBe(false);
  });
});

describe("planMirrorRange", () => {
  const base = { fallbackBinsBelow: 55, maxBinsBelow: 120, minBinsBelow: 20 };

  it("mirrors the depth below the active bin", () => {
    const r = planMirrorRange({ ...base, activeBin: 1000, sourceLowerBin: 940 });
    expect(r).toEqual({ binsBelow: 60, source: "mirrored", clampedFrom: null });
  });

  it("clamps a range wider than maxBinsBelow and reports the original width", () => {
    const r = planMirrorRange({ ...base, activeBin: 1000, sourceLowerBin: 700 });
    expect(r.binsBelow).toBe(120);
    expect(r.clampedFrom).toBe(300);
  });

  it("widens a range narrower than minBinsBelow", () => {
    const r = planMirrorRange({ ...base, activeBin: 1000, sourceLowerBin: 995 });
    expect(r.binsBelow).toBe(20);
    expect(r.clampedFrom).toBe(5);
  });

  it("falls back when their lower bin is unknown", () => {
    const r = planMirrorRange({ ...base, activeBin: 1000, sourceLowerBin: null });
    expect(r).toEqual({ binsBelow: 55, source: "fallback", clampedFrom: null });
  });

  it("falls back when their whole range sits at or above the active bin", () => {
    const r = planMirrorRange({ ...base, activeBin: 1000, sourceLowerBin: 1000 });
    expect(r.source).toBe("fallback");
  });
});
