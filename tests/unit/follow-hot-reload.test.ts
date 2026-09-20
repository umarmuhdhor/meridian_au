import { describe, it, expect } from "vitest";
import {
  createFollowWatcher,
  runFollowCycle,
  FOLLOW_BASE_TICK_MS,
  RECONCILE_GRACE_MS,
} from "../../src/app/follow/cycle.js";
import { createRegistry } from "../../src/app/tools/registry.js";
import { createDryRunChainClient } from "../../src/adapters/chain/dry-run.js";
import { createManualScheduler } from "../../src/adapters/scheduler/manual.js";
import { closePositionTool } from "../../src/app/tools/impls/close-position.js";
import { makeCtx, memFollowRepo } from "./tool-context.js";
import type { Clock } from "../../src/ports/clock.js";
import type { AppConfig } from "../../src/domain/schemas/config.js";
import type { OnChainPosition } from "../../src/domain/schemas/chain.js";
import type { FollowedWallet, MirroredPosition } from "../../src/domain/schemas/follow-wallet.js";
import type { WalletWatcher } from "../../src/ports/wallet-watcher.js";

const START = "2026-09-20T12:00:00.000Z";
const WHALE = "Whale1111111111111111111111111111111111111111";
const REGISTRY = createRegistry([closePositionTool]);

function mutableClock(startIso: string): Clock & { advance(ms: number): void } {
  let ms = new Date(startIso).getTime();
  return {
    now: () => new Date(ms),
    advance: (d: number) => {
      ms += d;
    },
  };
}

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
    source_position: null,
    opened_at: START,
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

function pos(): OnChainPosition {
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
    pnl_pct: 1,
    pnl_pct_suspicious: false,
    total_value_usd: 100,
    fee_per_tvl_24h: 10,
    age_minutes: 60,
    minutes_out_of_range: 0,
  };
}

/** Records every poll so we can count how many cycles actually ran. */
function countingWatcher(): WalletWatcher & { polls: number } {
  const w = {
    polls: 0,
    async getOpenPools(addr: string) {
      w.polls++;
      return { wallet: addr, pools: ["poolA"], positions: [], reliable: true };
    },
    async getPositionsInPool() {
      return [];
    },
  };
  return w;
}

function liveConfig(over: Record<string, unknown> = {}): AppConfig {
  const base = makeCtx().config;
  // `follow` is a fresh object per call, so mutating it in a test mimics exactly what
  // update_config does to the running daemon (Object.assign onto the live section).
  return { ...base, follow: { ...base.follow, enabled: true, ...over } } as AppConfig;
}

describe("createFollowWatcher — live config", () => {
  function setup(config: AppConfig) {
    const clock = mutableClock(START);
    const scheduler = createManualScheduler(clock.now().getTime());
    const chain = createDryRunChainClient({ clock, seed: { positions: [] } });
    const repo = memFollowRepo({ wallets: [wallet()], seen: { [WHALE]: [] }, seeded: [WHALE] });
    const ctx = makeCtx({ clock, chain, config, repos: { follow: repo } });
    const watcher = countingWatcher();
    const handle = createFollowWatcher({ ctx, registry: REGISTRY, watcher, repo, scheduler });
    const advance = async (ms: number) => {
      clock.advance(ms);
      await scheduler.advance(ms);
    };
    return { handle, watcher, config, advance };
  }

  it("does not poll while follow.enabled is false", async () => {
    const { watcher, advance } = setup(liveConfig({ enabled: false }));
    for (let i = 0; i < 10; i++) await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(0);
  });

  it("starts polling when enabled is flipped at runtime — no restart", async () => {
    const { watcher, config, advance } = setup(liveConfig({ enabled: false }));
    await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(0);

    // What update_config does to the running daemon.
    config.follow.enabled = true;

    await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(1);
  });

  it("honours intervalSec rather than firing on every base tick", async () => {
    const { watcher, advance } = setup(liveConfig({ intervalSec: 45 }));
    // First tick runs immediately (no previous run to rate-limit against).
    await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(1);
    // 15s and 30s later are inside the 45s interval.
    await advance(FOLLOW_BASE_TICK_MS);
    await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(1);
    // 45s after the first run.
    await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(2);
  });

  it("picks up an intervalSec change at runtime", async () => {
    const { watcher, config, advance } = setup(liveConfig({ intervalSec: 3600 }));
    await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(1);

    await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(1); // still inside the hour

    config.follow.intervalSec = 15;
    await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(2);
  });

  it("stops polling when disabled again", async () => {
    const { watcher, config, advance } = setup(liveConfig({ intervalSec: 15 }));
    await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(1);

    config.follow.enabled = false;
    for (let i = 0; i < 5; i++) await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(1);
  });

  it("runOnce bypasses the interval gate", async () => {
    const { handle, watcher, advance } = setup(liveConfig({ intervalSec: 3600 }));
    await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(1);

    await handle.runOnce();
    expect(watcher.polls).toBe(2);
  });

  it("stop() ends the schedule", async () => {
    const { handle, watcher, advance } = setup(liveConfig({ intervalSec: 15 }));
    await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(1);

    handle.stop();
    for (let i = 0; i < 5; i++) await advance(FOLLOW_BASE_TICK_MS);
    expect(watcher.polls).toBe(1);
  });
});

describe("reverse reconcile — grace window", () => {
  /** Chain holds nothing, so only the grace window can save the record. */
  function setup(openedAt: string, nowOffsetMs: number) {
    const clock = mutableClock(START);
    clock.advance(nowOffsetMs);
    const chain = createDryRunChainClient({ clock, seed: { positions: [] } });
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [mirror({ opened_at: openedAt })],
    });
    const ctx = makeCtx({ clock, chain, config: liveConfig(), repos: { follow: repo } });
    const watcher: WalletWatcher = {
      async getOpenPools(addr) {
        return { wallet: addr, pools: ["poolA"], positions: [], reliable: true };
      },
      async getPositionsInPool() {
        return [];
      },
    };
    return { ctx, repo, watcher };
  }

  it("does NOT reconcile a mirror that is still inside the grace window", async () => {
    // Deploy landed 30s ago; the RPC snapshot has not caught up yet.
    const { ctx, repo, watcher } = setup(START, 30_000);
    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher, repo });
    expect(r.reconciled).toBe(0);
    expect(await repo.listOpenMirrored()).toHaveLength(1);
  });

  it("reconciles once the grace window has passed", async () => {
    const { ctx, repo, watcher } = setup(START, RECONCILE_GRACE_MS + 1_000);
    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher, repo });
    expect(r.reconciled).toBe(1);
    expect(await repo.listOpenMirrored()).toEqual([]);
  });

  it("reconciles a record whose opened_at is unparseable rather than pinning it open", async () => {
    const { ctx, repo, watcher } = setup("not-a-date", 0);
    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher, repo });
    expect(r.reconciled).toBe(1);
  });

  it("leaves a mirror alone when its position IS on-chain, grace or not", async () => {
    const clock = mutableClock(START);
    clock.advance(RECONCILE_GRACE_MS * 10);
    const chain = createDryRunChainClient({ clock, seed: { positions: [pos()] } });
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [mirror()],
    });
    const ctx = makeCtx({ clock, chain, config: liveConfig(), repos: { follow: repo } });
    const watcher: WalletWatcher = {
      async getOpenPools(addr) {
        return { wallet: addr, pools: ["poolA"], positions: [], reliable: true };
      },
      async getPositionsInPool() {
        return [];
      },
    };
    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher, repo });
    expect(r.reconciled).toBe(0);
    expect(await repo.listOpenMirrored()).toHaveLength(1);
  });
});
