import { describe, it, expect, vi } from "vitest";
import type { Clock } from "../../src/ports/clock.js";
import { nullLogger } from "../../src/ports/logger.js";
import type { ChainClient } from "../../src/ports/chain-client.js";
import type { PositionRepo } from "../../src/ports/position-repo.js";
import type { ManagementConfig } from "../../src/domain/schemas/config.js";
import type {
  CloseResult,
  OnChainPosition,
  PositionsSnapshot,
} from "../../src/domain/schemas/chain.js";
import { closeViaTool, type CloseViaToolOutcome } from "../../src/app/tools/close-via-tool.js";
import { closePositionTool } from "../../src/app/tools/impls/close-position.js";
import { createRegistry } from "../../src/app/tools/registry.js";
import { createDryRunChainClient } from "../../src/adapters/chain/dry-run.js";
import { makeCtx } from "./tool-context.js";
import type { TrackedPosition } from "../../src/domain/schemas/position.js";
import {
  createPnlPoller,
  tickPnlPoller,
} from "../../src/app/management/pnl-poller.js";
import { createManualScheduler } from "../../src/adapters/scheduler/manual.js";

function mutableClock(startIso: string): Clock & { advance(ms: number): void } {
  let ms = new Date(startIso).getTime();
  return {
    now: () => new Date(ms),
    advance: (delta: number) => {
      ms += delta;
    },
  };
}

const mgmt: ManagementConfig = {
  stopLossPct: -50,
  stopLossGraceMinutes: 30,
  takeProfitPct: 5,
  outOfRangeWaitMinutes: 30,
  minFeePerTvl24h: 7,
  minAgeBeforeYieldCheck: 60,
  minClaimAmount: 5,
  trailingTakeProfit: true,
  trailingTriggerPct: 3,
  trailingDropPct: 1.5,
  deployAmountSol: 0.5,
  gasReserve: 0.2,
  positionSizePct: 0.35,
  pnlSanityMaxDiffPct: 5,
  solMode: false,
  autoSwapSlippageBps: 250,
  autoSwapMinUsd: 0.5,
  consolidateRetries: 1,
  consolidateRetryDelayMs: 0,
  dustSweepEnabled: false,
  dustSweepIntervalMin: 5,
  dustSweepMinUsd: 0.01,
  dustSweepSlippageBps: 500,
};

function makeLive(overrides: Partial<OnChainPosition & { _peakPnlPct: number }> = {}): OnChainPosition {
  return {
    position: "Pos1",
    pool: "PoolA",
    pair: "MEME/SOL",
    base_mint: "MintA",
    lower_bin: -20,
    upper_bin: 20,
    active_bin: 0,
    in_range: true,
    unclaimed_fees_usd: 0,
    pnl_pct: 8,
    pnl_pct_suspicious: false,
    total_value_usd: 100,
    fee_per_tvl_24h: 10,
    age_minutes: 120,
    ...overrides,
  };
}

function snap(...positions: OnChainPosition[]): PositionsSnapshot {
  return {
    total_positions: positions.length,
    positions,
    wallet: "W",
    fetched_at: "2026-07-05T12:00:00.000Z",
  };
}

describe("tickPnlPoller — pure", () => {
  it("queues (does not fire) on first-seen trailing drop", () => {
    const nowMs = 1_000_000;
    const now = new Date(nowMs);
    const live = makeLive({ pnl_pct: 7 });
    (live as OnChainPosition & { _peakPnlPct: number })._peakPnlPct = 10; // dropped 3 ≥ 1.5
    const { next, actions } = tickPnlPoller([], snap(live), now, mgmt, {
      confirmDelayMs: 15_000,
      confirmTolerancePct: 1,
    });
    expect(actions).toHaveLength(0);
    expect(next).toHaveLength(1);
    expect(next[0]?.positionAddress).toBe("Pos1");
    expect(next[0]?.peakPnlPct).toBe(10);
    expect(next[0]?.atQueueTime).toBe(7);
    expect(next[0]?.queuedAtMs).toBe(nowMs);
  });

  it("does not queue when peak is below trigger", () => {
    const live = makeLive({ pnl_pct: 1 });
    (live as OnChainPosition & { _peakPnlPct: number })._peakPnlPct = 2; // < trailingTriggerPct 3
    const { next } = tickPnlPoller([], snap(live), new Date(0), mgmt, {
      confirmDelayMs: 15_000,
      confirmTolerancePct: 1,
    });
    expect(next).toHaveLength(0);
  });

  it("does not queue when drop is below trailingDropPct", () => {
    const live = makeLive({ pnl_pct: 9 });
    (live as OnChainPosition & { _peakPnlPct: number })._peakPnlPct = 10; // drop 1 < 1.5
    const { next } = tickPnlPoller([], snap(live), new Date(0), mgmt, {
      confirmDelayMs: 15_000,
      confirmTolerancePct: 1,
    });
    expect(next).toHaveLength(0);
  });

  it("keeps pending until confirmDelayMs elapses", () => {
    const nowMs = 1_000_000;
    const pending = [
      {
        positionAddress: "Pos1",
        peakPnlPct: 10,
        atQueueTime: 7,
        queuedAtMs: nowMs - 5_000,
        reason: "old",
      },
    ];
    const live = makeLive({ pnl_pct: 7 });
    (live as OnChainPosition & { _peakPnlPct: number })._peakPnlPct = 10;
    const { next, actions } = tickPnlPoller(pending, snap(live), new Date(nowMs), mgmt, {
      confirmDelayMs: 15_000,
      confirmTolerancePct: 1,
    });
    expect(actions).toHaveLength(0);
    expect(next).toHaveLength(1); // still pending
  });

  it("fires close_confirmed when drop still holds after delay", () => {
    const queuedAtMs = 1_000_000;
    const nowMs = queuedAtMs + 20_000; // past 15s window
    const pending = [
      { positionAddress: "Pos1", peakPnlPct: 10, atQueueTime: 7, queuedAtMs, reason: "trailing" },
    ];
    const live = makeLive({ pnl_pct: 6.5 }); // now dropped further
    (live as OnChainPosition & { _peakPnlPct: number })._peakPnlPct = 10;
    const { next, actions } = tickPnlPoller(pending, snap(live), new Date(nowMs), mgmt, {
      confirmDelayMs: 15_000,
      confirmTolerancePct: 1,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("close_confirmed");
    expect(actions[0]?.positionAddress).toBe("Pos1");
    expect(actions[0]?.reason).toBe("trailing");
    expect(next).toHaveLength(0);
  });

  it("drops pending when price recovers past tolerance", () => {
    const queuedAtMs = 1_000_000;
    const nowMs = queuedAtMs + 20_000;
    const pending = [
      { positionAddress: "Pos1", peakPnlPct: 10, atQueueTime: 7, queuedAtMs, reason: "trailing" },
    ];
    // Recovered to 9 (drop 1, was 3 at queue → recovery 2 > tolerance 1)
    const live = makeLive({ pnl_pct: 9 });
    (live as OnChainPosition & { _peakPnlPct: number })._peakPnlPct = 10;
    const { next, actions } = tickPnlPoller(pending, snap(live), new Date(nowMs), mgmt, {
      confirmDelayMs: 15_000,
      confirmTolerancePct: 1,
    });
    expect(actions).toHaveLength(0);
    expect(next).toHaveLength(0);
  });

  it("skips positions with suspect PnL — never fires or queues", () => {
    const live = makeLive({ pnl_pct: null, pnl_pct_suspicious: true });
    (live as OnChainPosition & { _peakPnlPct: number })._peakPnlPct = 10;
    const { next, actions } = tickPnlPoller([], snap(live), new Date(0), mgmt, {
      confirmDelayMs: 15_000,
      confirmTolerancePct: 1,
    });
    expect(actions).toHaveLength(0);
    expect(next).toHaveLength(0);
  });

  it("drops pending when position vanishes from snapshot", () => {
    const queuedAtMs = 1_000_000;
    const nowMs = queuedAtMs + 20_000;
    const pending = [
      { positionAddress: "GonePos", peakPnlPct: 10, atQueueTime: 7, queuedAtMs, reason: "x" },
    ];
    const { next, actions } = tickPnlPoller(pending, snap(), new Date(nowMs), mgmt, {
      confirmDelayMs: 15_000,
      confirmTolerancePct: 1,
    });
    expect(actions).toHaveLength(0);
    expect(next).toHaveLength(0);
  });
});

describe("createPnlPoller — orchestration", () => {
  // Read-only chain: the poller must never close through it directly — closes go
  // through deps.closePosition (the close_position tool) so History records them.
  function fakeChain(snapshot: PositionsSnapshot): ChainClient {
    return {
      async getWalletBalance() {
        throw new Error("nope");
      },
      async getActiveBin() {
        throw new Error("nope");
      },
      async getMyPositions() {
        return snapshot;
      },
      async getWalletTokens() {
        return [];
      },
      async deployPosition() {
        throw new Error("nope");
      },
      async closePosition() {
        throw new Error("poller must close via deps.closePosition, not chain.closePosition");
      },
      async claimFees() {
        throw new Error("nope");
      },
    };
  }

  function fakePositionRepo(tracked: Record<string, TrackedPosition>): PositionRepo {
    return {
      async load() {
        throw new Error("nope");
      },
      async save() {},
      async get(addr: string) {
        return tracked[addr] ?? null;
      },
      async all() {
        return Object.values(tracked);
      },
      async upsert() {},
      async pushEvent() {},
    };
  }

  function trackedPos(over: Partial<TrackedPosition> = {}): TrackedPosition {
    return {
      position: "Pos1",
      pool: "PoolA",
      pool_name: "MEME/SOL",
      strategy: "bid_ask",
      bin_range: { min: -20, max: 20 },
      amount_sol: 0.5,
      active_bin_at_deploy: 0,
      deployed_at: "2026-07-05T10:00:00.000Z",
      peak_pnl_pct: 10,
      trailing_active: true,
      ...over,
    } as TrackedPosition;
  }

  const okClose = (): CloseViaToolOutcome => ({
    ok: true,
    result: {
      success: true,
      position_address: "Pos1",
      pool_address: "PoolA",
      base_mint: "MintA",
      final_pnl_pct: 7,
      final_value_usd: 100,
      fees_earned_usd: 2,
      reason: "trailing",
      tx: "SIG_1",
      dry_run: false,
    } as CloseResult,
  });

  it("fires close_confirmed after a trailing drop persists across two ticks", async () => {
    const clock = mutableClock("2026-07-05T12:00:00.000Z");
    const scheduler = createManualScheduler(clock.now().getTime());
    const closeSpy = vi.fn(async (_a: string, _r: string) => okClose());
    const poller = createPnlPoller({
      clock,
      logger: nullLogger,
      chain: fakeChain(snap(makeLive({ pnl_pct: 7 }))), // peak-drop already
      closePosition: closeSpy,
      scheduler,
      positionRepo: fakePositionRepo({ Pos1: trackedPos() }),
      config: mgmt,
      pollIntervalMs: 30_000,
      confirmDelayMs: 15_000,
      confirmTolerancePct: 1,
    });

    // First tick — queues, does not fire.
    await scheduler.advance(30_000);
    clock.advance(30_000);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(poller.peekPending()).toHaveLength(1);

    // Second tick 30s later — past 15s confirm window; drop still holds → fires.
    await scheduler.advance(30_000);
    clock.advance(30_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.calls[0]).toEqual(["Pos1", expect.stringMatching(/^Trailing TP confirmed/)]);
    expect(poller.peekPending()).toHaveLength(0);

    poller.stop();
  });

  it("survives a failed or throwing close without stopping the poller", async () => {
    const clock = mutableClock("2026-07-05T12:00:00.000Z");
    const scheduler = createManualScheduler(clock.now().getTime());
    const closeSpy = vi
      .fn<(a: string, r: string) => Promise<CloseViaToolOutcome>>()
      .mockResolvedValueOnce({ ok: false, error: "execute_failed: writes not armed" })
      .mockRejectedValueOnce(new Error("boom"));
    const poller = createPnlPoller({
      clock,
      logger: nullLogger,
      chain: fakeChain(snap(makeLive({ pnl_pct: 7 }))),
      closePosition: closeSpy,
      scheduler,
      positionRepo: fakePositionRepo({ Pos1: trackedPos() }),
      config: mgmt,
      pollIntervalMs: 30_000,
      confirmDelayMs: 15_000,
      confirmTolerancePct: 1,
    });
    for (let i = 0; i < 4; i++) {
      await scheduler.advance(30_000);
      clock.advance(30_000);
    }
    // queue → fail → re-queue → throw: both attempts made, poller still alive.
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(poller.peekPending()).toHaveLength(0);
    poller.stop();
  });

  const smart: ManagementConfig = { ...mgmt, smartExitEnabled: true, exitHardFloorPct: -25, exitOorProxyPct: -12 };

  it("does NOT fast-cut inside the pnl warm-up window (datapi −100% on a fresh deploy)", async () => {
    const clock = mutableClock("2026-07-05T12:00:00.000Z");
    const scheduler = createManualScheduler(clock.now().getTime());
    const closeSpy = vi.fn(async (_a: string, _r: string) => okClose());
    const poller = createPnlPoller({
      clock,
      logger: nullLogger,
      chain: fakeChain(snap(makeLive({ pnl_pct: -100, age_minutes: null }))),
      closePosition: closeSpy,
      scheduler,
      // deployed ~3 s before the first tick fires — the OTC-SOL / FLAME-SOL case
      positionRepo: fakePositionRepo({
        Pos1: trackedPos({ deployed_at: "2026-07-05T11:59:57.000Z", peak_pnl_pct: 0 }),
      }),
      config: smart,
      pollIntervalMs: 30_000,
    });
    await scheduler.advance(30_000);
    expect(closeSpy).not.toHaveBeenCalled();
    poller.stop();
  });

  it("treats a not-yet-tracked position as fresh (deploy hook has not written it yet)", async () => {
    const clock = mutableClock("2026-07-05T12:00:00.000Z");
    const scheduler = createManualScheduler(clock.now().getTime());
    const closeSpy = vi.fn(async (_a: string, _r: string) => okClose());
    const poller = createPnlPoller({
      clock,
      logger: nullLogger,
      chain: fakeChain(snap(makeLive({ pnl_pct: -100, age_minutes: null }))),
      closePosition: closeSpy,
      scheduler,
      positionRepo: fakePositionRepo({}),
      config: smart,
      pollIntervalMs: 30_000,
    });
    await scheduler.advance(30_000);
    expect(closeSpy).not.toHaveBeenCalled();
    poller.stop();
  });

  it("still fast-cuts a genuinely old position", async () => {
    const clock = mutableClock("2026-07-05T12:00:00.000Z");
    const scheduler = createManualScheduler(clock.now().getTime());
    const closeSpy = vi.fn(async (_a: string, _r: string) => okClose());
    const poller = createPnlPoller({
      clock,
      logger: nullLogger,
      chain: fakeChain(snap(makeLive({ pnl_pct: -30, age_minutes: null }))),
      closePosition: closeSpy,
      scheduler,
      positionRepo: fakePositionRepo({ Pos1: trackedPos({ peak_pnl_pct: 0 }) }),
      config: smart,
      pollIntervalMs: 30_000,
    });
    await scheduler.advance(30_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.calls[0]).toEqual(["Pos1", expect.stringMatching(/catastrophic/)]);
    poller.stop();
  });

  // Regression (2026-09-26): six smart-exit loss cuts were missing from the dashboard
  // History because the poller called chain.closePosition directly and skipped the
  // close_position post-hooks. Wire the real tool and assert the close is recorded.
  it("a fast-cut close lands in History (performance record) and the decision log", async () => {
    const clock = mutableClock("2026-07-05T12:00:00.000Z");
    const scheduler = createManualScheduler(clock.now().getTime());
    const chain = createDryRunChainClient({
      clock,
      seed: {
        positions: [
          makeLive({
            pnl_pct: -30,
            age_minutes: null,
            deployed_at: "2026-07-05T10:00:00.000Z",
            amount_sol: 0.5,
          }),
        ],
      },
    });
    const base = makeCtx();
    const ctx = makeCtx({ clock, chain, config: { ...base.config, management: smart } });
    const registry = createRegistry([closePositionTool]);
    const poller = createPnlPoller({
      clock,
      logger: nullLogger,
      chain,
      closePosition: (a, r) => closeViaTool(registry, ctx, a, r, "MANAGER"),
      scheduler,
      positionRepo: fakePositionRepo({ Pos1: trackedPos({ peak_pnl_pct: 0 }) }),
      config: smart,
      pollIntervalMs: 30_000,
    });

    await scheduler.advance(30_000);

    expect(chain.peekPositions()).toHaveLength(0);
    const perf = await ctx.repos.lessons.recentPerformance(10);
    expect(perf).toHaveLength(1);
    expect(perf[0]).toMatchObject({ position: "Pos1", close_reason: expect.stringMatching(/catastrophic/) });
    const decisions = await ctx.repos.decisions.recent(10);
    expect(decisions.some((d) => d.type === "close" && d.position === "Pos1" && d.actor === "MANAGER")).toBe(true);
    poller.stop();
  });
});
