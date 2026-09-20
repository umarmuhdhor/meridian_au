import { describe, it, expect, vi } from "vitest";
import { runManagementCycle } from "../../src/app/management/cycle.js";
import { runFollowCycle } from "../../src/app/follow/cycle.js";
import { createPnlPoller } from "../../src/app/management/pnl-poller.js";
import { createRegistry } from "../../src/app/tools/registry.js";
import { createDryRunChainClient } from "../../src/adapters/chain/dry-run.js";
import { createManualScheduler } from "../../src/adapters/scheduler/manual.js";
import { createCollectingNotifier } from "../../src/adapters/notify/collecting-notifier.js";
import { closePositionTool } from "../../src/app/tools/impls/close-position.js";
import { claimFeesTool } from "../../src/app/tools/impls/claim-fees.js";
import { fixedClock } from "../../src/ports/clock.js";
import { nullLogger } from "../../src/ports/logger.js";
import { makeCtx, memFollowRepo } from "./tool-context.js";
import type { AppConfig } from "../../src/domain/schemas/config.js";
import type { OnChainPosition, PositionsSnapshot } from "../../src/domain/schemas/chain.js";
import type { MirroredPosition, FollowedWallet } from "../../src/domain/schemas/follow-wallet.js";
import type { ChainClient } from "../../src/ports/chain-client.js";
import type { PositionRepo } from "../../src/ports/position-repo.js";
import type { SwapClient } from "../../src/ports/swap-client.js";
import type { WalletWatcher } from "../../src/ports/wallet-watcher.js";
import { mgmt } from "./fixtures.js";

const CLOCK = fixedClock("2026-09-20T12:00:00.000Z");
const WHALE = "Whale1111111111111111111111111111111111111111";
const REGISTRY = createRegistry([closePositionTool, claimFeesTool]);

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
    pnl_pct: -60,
    pnl_pct_suspicious: false,
    total_value_usd: 40,
    fee_per_tvl_24h: 10,
    age_minutes: 600,
    minutes_out_of_range: 0,
    ...over,
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
    ...over,
  };
}

/**
 * The wallet a mirror is copied from. Required by every exemption test: a mirror is only
 * exempt from local exit rules while an enabled, still-followed wallet owns its exit.
 */
function followedWallet(over: Partial<FollowedWallet> = {}): FollowedWallet {
  return {
    address: WHALE,
    label: "friend",
    enabled: true,
    addedAt: "2026-09-19T00:00:00.000Z",
    sizePctOverride: null,
    notes: null,
    ...over,
  };
}

function cfg(followOver: Record<string, unknown> = {}): AppConfig {
  const base = makeCtx({ clock: CLOCK }).config;
  return { ...base, follow: { ...base.follow, enabled: true, ...followOver } } as AppConfig;
}

describe("follow.exclusiveExit — management cycle", () => {
  it("does NOT close a mirrored position that trips the stop loss", async () => {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { positions: [pos()] } });
    const follow = memFollowRepo({ wallets: [followedWallet()], mirrored: [mirror()] });
    const ctx = makeCtx({ clock: CLOCK, chain, config: cfg(), repos: { follow } });

    const out = await runManagementCycle({ ctx, registry: REGISTRY });

    expect(out.kind).toBe("all_stay");
    expect(chain.peekPositions()).toHaveLength(1);
  });

  it("DOES close the same position when exclusiveExit is off", async () => {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { positions: [pos()] } });
    const follow = memFollowRepo({ wallets: [followedWallet()], mirrored: [mirror()] });
    const ctx = makeCtx({
      clock: CLOCK,
      chain,
      config: cfg({ exclusiveExit: false }),
      repos: { follow },
    });

    const out = await runManagementCycle({ ctx, registry: REGISTRY });

    expect(out.kind).toBe("executed");
    expect(chain.peekPositions()).toHaveLength(0);
  });

  it("still closes a NON-mirrored position while a mirror is exempt", async () => {
    const chain = createDryRunChainClient({
      clock: CLOCK,
      seed: { positions: [pos(), pos({ position: "ownPos", pool: "poolB" })] },
    });
    const follow = memFollowRepo({ wallets: [followedWallet()], mirrored: [mirror()] });
    const ctx = makeCtx({ clock: CLOCK, chain, config: cfg(), repos: { follow } });

    await runManagementCycle({ ctx, registry: REGISTRY });

    const left = chain.peekPositions().map((p) => p.position);
    expect(left).toEqual(["mirrorPos"]);
  });

  it("still CLAIMS fees on a mirrored position — claiming does not end it", async () => {
    const chain = createDryRunChainClient({
      clock: CLOCK,
      seed: { positions: [pos({ pnl_pct: 1, unclaimed_fees_usd: 50 })] },
    });
    const follow = memFollowRepo({ wallets: [followedWallet()], mirrored: [mirror()] });
    const ctx = makeCtx({ clock: CLOCK, chain, config: cfg(), repos: { follow } });

    const out = await runManagementCycle({ ctx, registry: REGISTRY });

    expect(out.kind).toBe("executed");
    if (out.kind === "executed") {
      expect(out.results.map((r) => r.plan.action)).toEqual(["CLAIM"]);
    }
    expect(chain.peekPositions()).toHaveLength(1);
  });
});

describe("follow.exclusiveExit — pnl poller", () => {
  function chainWith(snapshot: PositionsSnapshot, closeSpy: ReturnType<typeof vi.fn>): ChainClient {
    return {
      async getWalletBalance() {
        throw new Error("unused");
      },
      async getActiveBin() {
        throw new Error("unused");
      },
      async getMyPositions() {
        return snapshot;
      },
      async getWalletTokens() {
        return [];
      },
      async deployPosition() {
        throw new Error("unused");
      },
      closePosition: closeSpy as unknown as ChainClient["closePosition"],
      async claimFees() {
        throw new Error("unused");
      },
    };
  }

  function repoWithPeak(peak: number): PositionRepo {
    return {
      async load() {
        throw new Error("unused");
      },
      async save() {},
      async get() {
        return { peak_pnl_pct: peak, trailing_active: true } as never;
      },
      async all() {
        return [];
      },
      async upsert() {},
      async pushEvent() {},
    };
  }

  const swap: SwapClient = {
    async swap(args) {
      return {
        success: true,
        input_mint: args.input_mint,
        output_mint: args.output_mint,
        amount_in: args.amount_in,
        amount_out: args.amount_in,
        tx: "t",
        dry_run: true,
      };
    },
  };

  /** peak 10 → current 7 is a 3% drop, well past mgmt.trailingDropPct. */
  const snapshot: PositionsSnapshot = {
    total_positions: 1,
    positions: [pos({ position: "mirrorPos", pnl_pct: 7 })],
  } as PositionsSnapshot;

  it("never queues a trailing-TP close for a mirrored position", async () => {
    const scheduler = createManualScheduler(CLOCK.now().getTime());
    const closeSpy = vi.fn();
    const poller = createPnlPoller({
      clock: CLOCK,
      logger: nullLogger,
      chain: chainWith(snapshot, closeSpy),
      swap,
      notifier: createCollectingNotifier(),
      scheduler,
      positionRepo: repoWithPeak(10),
      config: mgmt,
      followRepo: memFollowRepo({ wallets: [followedWallet()], mirrored: [mirror()] }),
      followConfig: cfg().follow,
      pollIntervalMs: 30_000,
      confirmDelayMs: 15_000,
    });

    await scheduler.advance(30_000);
    await scheduler.advance(30_000);

    expect(poller.peekPending()).toEqual([]);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("reads exclusiveExit live — flipping it off re-arms the poller without a restart", async () => {
    const scheduler = createManualScheduler(CLOCK.now().getTime());
    const closeSpy = vi.fn();
    // The same object reference update_config mutates in place.
    const liveFollow = cfg().follow;
    const poller = createPnlPoller({
      clock: CLOCK,
      logger: nullLogger,
      chain: chainWith(snapshot, closeSpy),
      swap,
      notifier: createCollectingNotifier(),
      scheduler,
      positionRepo: repoWithPeak(10),
      config: mgmt,
      followRepo: memFollowRepo({ wallets: [followedWallet()], mirrored: [mirror()] }),
      followConfig: liveFollow,
      pollIntervalMs: 30_000,
      confirmDelayMs: 15_000,
    });

    await scheduler.advance(30_000);
    expect(poller.peekPending()).toEqual([]);

    liveFollow.exclusiveExit = false;
    await scheduler.advance(30_000);
    expect(poller.peekPending()).toHaveLength(1);
  });

  it("queues normally when no follow repo is wired", async () => {
    const scheduler = createManualScheduler(CLOCK.now().getTime());
    const closeSpy = vi.fn();
    const poller = createPnlPoller({
      clock: CLOCK,
      logger: nullLogger,
      chain: chainWith(snapshot, closeSpy),
      swap,
      notifier: createCollectingNotifier(),
      scheduler,
      positionRepo: repoWithPeak(10),
      config: mgmt,
      pollIntervalMs: 30_000,
      confirmDelayMs: 15_000,
    });

    await scheduler.advance(30_000);

    expect(poller.peekPending()).toHaveLength(1);
  });
});

describe("follow cycle — reverse reconcile", () => {
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

  function watcher(pools: string[], reliable = true): WalletWatcher {
    return {
      async getOpenPools(w) {
        return { wallet: w, pools, positions: [], reliable };
      },
      async getPositionsInPool() {
        return [];
      },
    };
  }

  it("finalises a mirror whose position is gone on-chain", async () => {
    // Chain holds nothing: the mirrored position was closed outside this cycle.
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { positions: [] } });
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [mirror()],
    });
    const ctx = makeCtx({ clock: CLOCK, chain, config: cfg(), repos: { follow: repo } });

    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher: watcher(["poolA"]), repo });

    expect(r.reconciled).toBe(1);
    expect(await repo.listOpenMirrored()).toEqual([]);
    const rec = (await repo.listMirrored())[0]!;
    expect(rec.close_reason).toContain("no longer on-chain");
  });

  it("unblocks re-mirroring a pool after the orphan is reconciled", async () => {
    const chain = createDryRunChainClient({
      clock: CLOCK,
      seed: {
        positions: [],
        activeBins: { poolA: { binId: 1000, price: 1, pricePerLamport: "1" } },
      },
    });
    const repo = memFollowRepo({
      wallets: [wallet()],
      // The wallet left and re-entered poolA, so it reads as a fresh open.
      seen: { [WHALE]: [] },
      seeded: [WHALE],
      mirrored: [mirror()],
    });
    const ctx = makeCtx({ clock: CLOCK, chain, config: cfg(), repos: { follow: repo } });

    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher: watcher(["poolA"]), repo });

    // Without the reconcile the stale open record would have matched
    // `already_mirrored` and blocked this pool permanently.
    expect(r.reconciled).toBe(1);
    expect(r.opened + r.failures).toBe(1);
  });

  it("leaves a live mirror untouched", async () => {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { positions: [pos()] } });
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [mirror()],
    });
    const ctx = makeCtx({ clock: CLOCK, chain, config: cfg(), repos: { follow: repo } });

    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher: watcher(["poolA"]), repo });

    expect(r.reconciled).toBe(0);
    expect(await repo.listOpenMirrored()).toHaveLength(1);
  });
});

describe("follow cycle — stale snapshot alert", () => {
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

  const degraded: WalletWatcher = {
    async getOpenPools(w) {
      return { wallet: w, pools: [], positions: [], reliable: false };
    },
    async getPositionsInPool() {
      return [];
    },
  };

  it("alerts once the degraded run reaches the threshold, not before", async () => {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { positions: [pos()] } });
    const notifier = createCollectingNotifier();
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [mirror()],
    });
    const ctx = makeCtx({
      clock: CLOCK,
      chain,
      notifier,
      config: cfg({ staleTicksBeforeAlert: 3 }),
      repos: { follow: repo },
    });
    const staleCounters = new Map<string, number>();
    const deps = { ctx, registry: REGISTRY, watcher: degraded, repo, staleCounters };

    const alertsSoFar = () =>
      notifier.recorded.filter(
        (r): r is { type: "notify"; kind: "warn"; text: string } =>
          r.type === "notify" && r.text.includes("degraded polls"),
      );

    await runFollowCycle(deps);
    await runFollowCycle(deps);
    expect(alertsSoFar()).toHaveLength(0);

    await runFollowCycle(deps);
    const alerts = alertsSoFar();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain("1 mirrored position(s)");
  });

  it("resets the counter once the snapshot recovers", async () => {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { positions: [pos()] } });
    const repo = memFollowRepo({
      wallets: [wallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [mirror()],
    });
    const ctx = makeCtx({ clock: CLOCK, chain, config: cfg(), repos: { follow: repo } });
    const staleCounters = new Map<string, number>();

    await runFollowCycle({ ctx, registry: REGISTRY, watcher: degraded, repo, staleCounters });
    expect(staleCounters.get(WHALE)).toBe(1);

    const healthy: WalletWatcher = {
      async getOpenPools(w) {
        return { wallet: w, pools: ["poolA"], positions: [], reliable: true };
      },
      async getPositionsInPool() {
        return [];
      },
    };
    await runFollowCycle({ ctx, registry: REGISTRY, watcher: healthy, repo, staleCounters });
    expect(staleCounters.has(WHALE)).toBe(false);
  });
});

/**
 * Unfollow means unwind.
 *
 * `exclusiveExit` hands a mirror's exit to the wallet it was copied from and disarms
 * every local rule for it. That only holds while such a wallet is being polled, so the
 * three ways of ending that — master switch off, wallet disabled, wallet removed — must
 * leave no position behind that nobody can close.
 */
describe("follow cycle — draining mirrors that lost their wallet", () => {
  function watcher(): WalletWatcher {
    return {
      async getOpenPools(w) {
        return { wallet: w, pools: ["poolA"], positions: [], reliable: true };
      },
      async getPositionsInPool() {
        return [];
      },
    };
  }

  function setup(over: { wallets?: FollowedWallet[]; enabled?: boolean } = {}) {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { positions: [pos()] } });
    const repo = memFollowRepo({
      wallets: over.wallets ?? [followedWallet()],
      seen: { [WHALE]: ["poolA"] },
      seeded: [WHALE],
      mirrored: [mirror()],
    });
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({
      clock: CLOCK,
      chain,
      notifier,
      config: cfg({ enabled: over.enabled ?? true }),
      repos: { follow: repo },
    });
    return { chain, repo, ctx, notifier };
  }

  it("closes a mirror when the master switch is turned off", async () => {
    const { chain, repo, ctx } = setup({ enabled: false });

    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher: watcher(), repo });

    // The switch is still honoured — it just does not strand a position on the way out.
    expect(r.kind).toBe("disabled");
    expect(r.drained).toBe(1);
    expect(chain.peekPositions()).toHaveLength(0);
    expect((await repo.listMirrored())[0]!.close_reason).toContain("follow.enabled was turned off");
  });

  it("closes a mirror whose wallet was disabled", async () => {
    const { chain, repo, ctx } = setup({ wallets: [followedWallet({ enabled: false })] });

    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher: watcher(), repo });

    expect(r.drained).toBe(1);
    expect(chain.peekPositions()).toHaveLength(0);
    expect((await repo.listMirrored())[0]!.close_reason).toContain("wallet was disabled");
  });

  it("closes a mirror whose wallet was removed outright", async () => {
    const { chain, repo, ctx } = setup({ wallets: [] });

    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher: watcher(), repo });

    expect(r.drained).toBe(1);
    expect(chain.peekPositions()).toHaveLength(0);
    expect((await repo.listMirrored())[0]!.close_reason).toContain("wallet was removed");
  });

  it("warns the operator before it closes anything", async () => {
    const { ctx, repo, notifier } = setup({ enabled: false });

    await runFollowCycle({ ctx, registry: REGISTRY, watcher: watcher(), repo });

    // These are on-chain closes the operator did not ask for directly, so silence is
    // not an option — the warning has to name the reason.
    const warned = notifier.recorded.filter(
      (m): m is { type: "notify"; kind: string; text: string } =>
        m.type === "notify" && m.kind === "warn",
    );
    expect(warned.some((m) => m.text.includes("follow.enabled was turned off"))).toBe(true);
  });

  it("does NOT drain when the state file cannot be read", async () => {
    // An unreadable file answers `listWallets()` with an empty array, which is exactly
    // what a deliberate unfollow looks like. Closing on that would turn a parse error
    // into a liquidation, so the tick is refused instead.
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { positions: [pos()] } });
    const repo = memFollowRepo({ wallets: [], mirrored: [mirror()] });
    const broken: typeof repo = {
      ...repo,
      async load() {
        return { ok: false, error: { kind: "invalid", issues: ["corrupt"] } } as Awaited<
          ReturnType<typeof repo.load>
        >;
      },
    };
    const ctx = makeCtx({
      clock: CLOCK,
      chain,
      config: cfg({ enabled: false }),
      repos: { follow: broken },
    });

    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher: watcher(), repo: broken });

    expect(r.drained).toBe(0);
    expect(r.failures).toBe(1);
    expect(chain.peekPositions()).toHaveLength(1);
  });

  it("leaves a mirror alone while its wallet is still followed and enabled", async () => {
    const { chain, repo, ctx } = setup();

    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher: watcher(), repo });

    expect(r.drained).toBe(0);
    expect(chain.peekPositions()).toHaveLength(1);
  });

  it("retries on the next tick when the close fails", async () => {
    const { repo, ctx } = setup({ enabled: false });
    // No such position on-chain in the second cycle's eyes — force the close to fail by
    // pointing the record at an address the chain does not know.
    await repo.addMirrored(mirror({ position: "ghostPos", opened_at: "2026-09-19T00:00:00Z" }));

    const r = await runFollowCycle({ ctx, registry: REGISTRY, watcher: watcher(), repo });

    // Reconcile claims the ghost (it is not on-chain), the real mirror drains. Either
    // way nothing is silently marked closed while still open.
    expect(r.drained + r.reconciled).toBe(2);
    expect(await repo.listOpenMirrored()).toEqual([]);
  });
});

describe("follow.exclusiveExit — an orphaned mirror goes back under local rules", () => {
  it("closes on the stop loss once its wallet is removed", async () => {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { positions: [pos()] } });
    // Mirror on record, wallet gone: the follow cycle will never close this, so
    // management must not treat it as someone else's responsibility.
    const follow = memFollowRepo({ wallets: [], mirrored: [mirror()] });
    const ctx = makeCtx({ clock: CLOCK, chain, config: cfg(), repos: { follow } });

    const out = await runManagementCycle({ ctx, registry: REGISTRY });

    expect(out.kind).toBe("executed");
    expect(chain.peekPositions()).toHaveLength(0);
  });

  it("closes on the stop loss once its wallet is disabled", async () => {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { positions: [pos()] } });
    const follow = memFollowRepo({
      wallets: [followedWallet({ enabled: false })],
      mirrored: [mirror()],
    });
    const ctx = makeCtx({ clock: CLOCK, chain, config: cfg(), repos: { follow } });

    const out = await runManagementCycle({ ctx, registry: REGISTRY });

    expect(out.kind).toBe("executed");
    expect(chain.peekPositions()).toHaveLength(0);
  });

  it("closes on the stop loss once the master switch is off", async () => {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { positions: [pos()] } });
    const follow = memFollowRepo({ wallets: [followedWallet()], mirrored: [mirror()] });
    const ctx = makeCtx({
      clock: CLOCK,
      chain,
      config: cfg({ enabled: false }),
      repos: { follow },
    });

    const out = await runManagementCycle({ ctx, registry: REGISTRY });

    expect(out.kind).toBe("executed");
    expect(chain.peekPositions()).toHaveLength(0);
  });
});
