import { describe, it, expect, vi } from "vitest";
import {
  armBounceWatch,
  bounceShadowNetPct,
  evaluateBounceWatch,
  isBounceEligibleCloseReason,
  isBounceTrigger,
  simulateBounceExit,
} from "../../src/domain/rules/bounce-exit.js";
import { createPnlPoller, tickPnlPoller } from "../../src/app/management/pnl-poller.js";
import { planForPosition, runManagementCycle } from "../../src/app/management/cycle.js";
import { pickBounceShadowable, runBounceShadow, tallyBounceShadow } from "../../src/app/learning/bounce-shadow.js";
import { createManualScheduler } from "../../src/adapters/scheduler/manual.js";
import { createDryRunChainClient } from "../../src/adapters/chain/dry-run.js";
import { createCollectingNotifier } from "../../src/adapters/notify/collecting-notifier.js";
import { createFakeKlineClient } from "../../src/adapters/market/fake-kline.js";
import { createRegistry } from "../../src/app/tools/registry.js";
import { closePositionTool } from "../../src/app/tools/impls/close-position.js";
import { claimFeesTool } from "../../src/app/tools/impls/claim-fees.js";
import { fixedClock, type Clock } from "../../src/ports/clock.js";
import { nullLogger } from "../../src/ports/logger.js";
import type { ChainClient } from "../../src/ports/chain-client.js";
import type { PositionRepo } from "../../src/ports/position-repo.js";
import type { AppConfig, ManagementConfig } from "../../src/domain/schemas/config.js";
import type { OnChainPosition, PositionsSnapshot } from "../../src/domain/schemas/chain.js";
import type { TrackedPosition } from "../../src/domain/schemas/position.js";
import type { KlineCandle } from "../../src/domain/schemas/kline.js";
import type { PerformanceRecord } from "../../src/domain/schemas/lesson.js";
import { makeCtx, memLessonRepo } from "./tool-context.js";
import { mgmt, screening } from "./fixtures.js";

const T0 = "2026-10-10T12:00:00.000Z";
const smart: ManagementConfig = { ...mgmt, smartExitEnabled: true, trailingTakeProfit: true };
const bounce: ManagementConfig = { ...smart, bounceExitEnabled: true };
const CONFIRM = { confirmDelayMs: 15_000, confirmTolerancePct: 1 };

function live(over: Partial<OnChainPosition> = {}): OnChainPosition {
  return {
    position: "Pos1",
    pool: "PoolA",
    pair: "MEME-SOL",
    base_mint: "MintA",
    lower_bin: 0,
    upper_bin: 68,
    active_bin: -5,
    in_range: false,
    unclaimed_fees_usd: 0,
    pnl_pct: -30,
    pnl_pct_suspicious: false,
    total_value_usd: 25,
    fee_per_tvl_24h: 10,
    age_minutes: 300,
    ...over,
  };
}

function snap(...positions: OnChainPosition[]): PositionsSnapshot {
  return { total_positions: positions.length, positions, wallet: "W", fetched_at: T0 };
}

function tracked(over: Partial<TrackedPosition> = {}): TrackedPosition {
  return {
    position: "Pos1",
    pool: "PoolA",
    pool_name: "MEME-SOL",
    strategy: "spot",
    bin_range: { lower_bin: 0, upper_bin: 68 },
    amount_sol: 0.3,
    deployed_at: "2026-10-10T07:00:00.000Z",
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    trailing_active: false,
    ...over,
  };
}

/** Position repo that actually stores — memPositionRepo in tool-context is a no-op. */
function storeRepo(initial: TrackedPosition[] = []): PositionRepo & { db: Map<string, TrackedPosition> } {
  const db = new Map(initial.map((t) => [t.position, t]));
  return {
    db,
    async load() {
      return { ok: true, value: { positions: Object.fromEntries(db), recentEvents: [], lastUpdated: null } };
    },
    async save() {},
    async get(addr) {
      return db.get(addr) ?? null;
    },
    async all() {
      return [...db.values()];
    },
    async upsert(t) {
      db.set(t.position, t);
    },
    async pushEvent() {},
  };
}

const watchAt = (iso: string, triggerPnl = -30) => armBounceWatch(triggerPnl, "catastrophic: pnl -30.0% ≤ floor -25%", new Date(iso));

describe("evaluateBounceWatch", () => {
  const w = watchAt(T0, -20); // value 0.80 at the trigger
  const at = (min: number) => new Date(Date.parse(T0) + min * 60_000);

  it("takes once value recovers bounceTakePct from the trigger", () => {
    // 0.80 × 1.15 = 0.92 → pnl −8; −7.5 clears it
    const v = evaluateBounceWatch(w, { pnl_pct: -7.5 }, at(30), mgmt);
    expect(v).toMatchObject({ action: "CLOSE", outcome: "take" });
    if (v.action === "CLOSE") expect(v.reason.startsWith("bounce-exit (take)")).toBe(true);
  });

  it("stops on a further bounceStopPct drop", () => {
    // 0.80 × 0.75 = 0.60 → pnl −40
    expect(evaluateBounceWatch(w, { pnl_pct: -40 }, at(30), mgmt)).toMatchObject({ action: "CLOSE", outcome: "stop" });
  });

  it("holds in between, then times out", () => {
    expect(evaluateBounceWatch(w, { pnl_pct: -15 }, at(30), mgmt).action).toBe("HOLD");
    expect(evaluateBounceWatch(w, { pnl_pct: -15 }, at(360), mgmt)).toMatchObject({ action: "CLOSE", outcome: "timeout" });
  });

  it("an unreadable pnl can only time out", () => {
    expect(evaluateBounceWatch(w, { pnl_pct: null }, at(30), mgmt).action).toBe("HOLD");
    expect(evaluateBounceWatch(w, { pnl_pct: -60, pnl_pct_suspicious: true }, at(30), mgmt).action).toBe("HOLD");
    expect(evaluateBounceWatch(w, { pnl_pct: null }, at(361), mgmt)).toMatchObject({ action: "CLOSE", outcome: "timeout" });
  });
});

describe("eligibility", () => {
  it("arms only CATASTROPHIC and OOR-below DYING", () => {
    expect(isBounceTrigger("CATASTROPHIC", { active_bin: 5, lower_bin: 0 })).toBe(true);
    expect(isBounceTrigger("DYING", { active_bin: -1, lower_bin: 0 })).toBe(true);
    expect(isBounceTrigger("DYING", { active_bin: 3, lower_bin: 0 })).toBe(false); // red streak in range
    expect(isBounceTrigger("OK", { active_bin: -1, lower_bin: 0 })).toBe(false); // take-profit / OOR-above / low-yield
    expect(isBounceTrigger(undefined, { active_bin: -1, lower_bin: 0 })).toBe(false);
  });

  it("recognises the recorded deep-loss close reasons, never a bounce close or a mirror", () => {
    expect(isBounceEligibleCloseReason("smart-exit fast-cut: dying (poller): OOR-below + pnl -15.4% ≤ -12%")).toBe(true);
    expect(isBounceEligibleCloseReason("catastrophic: pnl -45.2% ≤ floor -25%")).toBe(true);
    expect(isBounceEligibleCloseReason("dying: OOR-below + support broken (pnl -18.0%)")).toBe(true);
    expect(isBounceEligibleCloseReason("bounce-exit (stop): value -25.1% since trigger")).toBe(false);
    expect(isBounceEligibleCloseReason("OOR")).toBe(false);
    expect(isBounceEligibleCloseReason("follow: a exited PARASITE-SOL")).toBe(false);
  });
});

describe("simulateBounceExit", () => {
  const closeTs = Math.floor(Date.parse(T0) / 1000);
  const c = (offsetMin: number, h: number, l: number, cl = (h + l) / 2): KlineCandle => ({
    t: closeTs + offsetMin * 60,
    o: cl,
    h,
    l,
    c: cl,
    v: 1,
  });

  it("anchors on the candle in progress at the close and takes on the rebound", () => {
    const sim = simulateBounceExit([c(-2, 1, 1, 1), c(3, 1.05, 0.95), c(8, 1.2, 1.0)], closeTs, mgmt);
    expect(sim).toMatchObject({ ok: true, outcome: "take", candles: 2 });
    if (sim.ok) expect(sim.multiplier).toBeCloseTo(1.15);
  });

  it("checks the stop before the take inside one candle (worst case)", () => {
    expect(simulateBounceExit([c(-2, 1, 1, 1), c(3, 1.3, 0.7)], closeTs, mgmt)).toMatchObject({ ok: true, outcome: "stop" });
  });

  it("times out at the last close inside the window and ignores later candles", () => {
    const sim = simulateBounceExit([c(-2, 1, 1, 1), c(60, 1.05, 0.95, 1.02), c(400, 2, 2, 2)], closeTs, mgmt);
    expect(sim).toMatchObject({ ok: true, outcome: "timeout", minutesToExit: 360 });
    if (sim.ok) expect(sim.multiplier).toBeCloseTo(1.02);
  });

  it("refuses without an anchor or post-close candles", () => {
    expect(simulateBounceExit([c(60, 1, 1)], closeTs, mgmt).ok).toBe(false);
    expect(simulateBounceExit([c(-2, 1, 1)], closeTs, mgmt).ok).toBe(false);
  });

  it("shadow net scales only the price leg", () => {
    // price leg −20%, fees +5% → net −15%; ×1.15 → (0.8×1.15 − 1 + 0.05) = −3%
    const net = bounceShadowNetPct({ pnl_pct: -15, pnl_usd: -20, fees_earned_usd: 5, initial_value_usd: 100 }, 1.15);
    expect(net).toBeCloseTo(-3);
  });
});

describe("tickPnlPoller — bounce-exit", () => {
  const now = new Date(T0);

  it("feature off → a deep loss is fast-cut exactly as before", () => {
    const { actions } = tickPnlPoller([], snap(live()), now, smart, CONFIRM);
    expect(actions).toEqual([{ kind: "fast_cut", positionAddress: "Pos1", reason: expect.stringMatching(/catastrophic/) }]);
  });

  it("feature on → arms instead of closing", () => {
    const { actions } = tickPnlPoller([], snap(live()), now, bounce, CONFIRM);
    expect(actions).toEqual([
      { kind: "bounce_arm", positionAddress: "Pos1", reason: expect.stringMatching(/catastrophic/), triggerPnlPct: -30 },
    ]);
  });

  it("a watched position holds silently and is never queued for trailing-TP", () => {
    const p = Object.assign(live({ pnl_pct: -28 }), { _bounceWatch: watchAt(T0), _peakPnlPct: 10 });
    const { actions, next } = tickPnlPoller([], snap(p), new Date(Date.parse(T0) + 60_000), bounce, CONFIRM);
    expect(actions).toHaveLength(0);
    expect(next).toHaveLength(0);
  });

  it("a watched position closes on the rebound", () => {
    // trigger −30 → 0.70 × 1.15 = 0.805 → pnl −19.5
    const p = Object.assign(live({ pnl_pct: -19 }), { _bounceWatch: watchAt(T0) });
    const { actions } = tickPnlPoller([], snap(p), new Date(Date.parse(T0) + 60_000), bounce, CONFIRM);
    expect(actions).toEqual([{ kind: "fast_cut", positionAddress: "Pos1", reason: expect.stringMatching(/^bounce-exit \(take\)/) }]);
  });

  it("a stale watch is ignored while the feature is off", () => {
    const p = Object.assign(live(), { _bounceWatch: watchAt(T0) });
    const { actions } = tickPnlPoller([], snap(p), now, smart, CONFIRM);
    expect(actions[0]?.kind).toBe("fast_cut");
  });
});

describe("createPnlPoller — bounce-exit", () => {
  function chainWith(s: PositionsSnapshot): ChainClient {
    const nope = async () => {
      throw new Error("nope");
    };
    return {
      getWalletBalance: nope,
      getActiveBin: nope,
      getMyPositions: async () => s,
      getWalletTokens: async () => [],
      deployPosition: nope,
      closePosition: nope,
      claimFees: nope,
    };
  }

  function run(repo: PositionRepo, notifier = createCollectingNotifier()) {
    let ms = Date.parse(T0);
    const clock: Clock = { now: () => new Date(ms) };
    const scheduler = createManualScheduler(ms);
    const closeSpy = vi.fn(async (_a: string, _r: string) => ({ ok: false as const, error: "test" }));
    const poller = createPnlPoller({
      clock,
      logger: nullLogger,
      chain: chainWith(snap(live())),
      closePosition: closeSpy,
      scheduler,
      positionRepo: repo,
      config: bounce,
      notifier,
      pollIntervalMs: 30_000,
    });
    return {
      closeSpy,
      notifier,
      tick: async () => {
        ms += 30_000;
        await scheduler.advance(30_000);
      },
      stop: () => poller.stop(),
    };
  }

  it("persists the watch, announces it, and does not close", async () => {
    const repo = storeRepo([tracked()]);
    const h = run(repo);
    await h.tick();
    expect(h.closeSpy).not.toHaveBeenCalled();
    expect(repo.db.get("Pos1")?.bounce_watch).toMatchObject({ trigger_pnl_pct: -30 });
    expect(h.notifier.recorded.some((r) => r.type === "notify" && r.text.includes("Bounce watch MEME-SOL"))).toBe(true);
    // Second tick: watched, pnl unchanged → still holding.
    await h.tick();
    expect(h.closeSpy).not.toHaveBeenCalled();
    h.stop();
  });

  it("no tracked record to hold the watch → closes as before", async () => {
    let ms = Date.parse(T0);
    const scheduler = createManualScheduler(ms);
    const closeSpy = vi.fn(async (_a: string, _r: string) => ({ ok: false as const, error: "test" }));
    const repo = storeRepo([tracked({ closed: true })]); // only a closed record → cannot arm
    const poller = createPnlPoller({
      clock: { now: () => new Date(ms) },
      logger: nullLogger,
      chain: chainWith(snap(live())),
      closePosition: closeSpy,
      scheduler,
      positionRepo: repo,
      config: bounce,
      pollIntervalMs: 30_000,
    });
    ms += 30_000;
    await scheduler.advance(30_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.calls[0]?.[1]).toMatch(/catastrophic/);
    poller.stop();
  });
});

describe("management cycle — bounce-exit", () => {
  const CLOCK = fixedClock(T0);
  const REGISTRY = createRegistry([closePositionTool, claimFeesTool]);
  const config = (m: ManagementConfig): AppConfig =>
    ({
      risk: { maxPositions: 3 },
      management: { ...m, minClaimAmount: 1000 },
      strategy: { strategy: "spot", binsBelow: 69 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30, healthCheckIntervalMin: 60 },
      screening,
    }) as unknown as AppConfig;

  it("planForPosition: a watch owns the position — holds, then takes", () => {
    const ctx = { config: config(bounce) };
    const watch = watchAt(T0);
    const later = new Date(Date.parse(T0) + 30 * 60_000);
    expect(planForPosition(live({ pnl_pct: -28 }), ctx, undefined, { watch, now: later })).toMatchObject({ action: "STAY" });
    expect(planForPosition(live({ pnl_pct: -19 }), ctx, undefined, { watch, now: later })).toMatchObject({ action: "CLOSE" });
    // A take-profit-looking pnl would never reach the TP rule while watched.
    expect(planForPosition(live({ pnl_pct: 7 }), ctx, undefined, { watch, now: later }).reason).toMatch(/^bounce-exit/);
  });

  it("a CATASTROPHIC close is turned into an armed watch", async () => {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { walletSol: 5, positions: [live()] } });
    const repo = storeRepo([tracked()]);
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ chain, clock: CLOCK, config: config(bounce), notifier, repos: { positions: repo } });
    const out = await runManagementCycle({ ctx, registry: REGISTRY });
    expect(out.kind).toBe("all_stay");
    expect(repo.db.get("Pos1")?.bounce_watch).toMatchObject({ trigger_pnl_pct: -30 });
    expect(notifier.recorded.some((r) => r.type === "notify" && r.text.startsWith("⏳ Bounce watch"))).toBe(true);
  });

  it("feature off → closes at once, and stale watches are cleared", async () => {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { walletSol: 5, positions: [live({ pnl_pct: -5, active_bin: 10, in_range: true })] } });
    const repo = storeRepo([tracked({ bounce_watch: watchAt(T0) })]);
    const ctx = makeCtx({ chain, clock: CLOCK, config: config(smart), repos: { positions: repo } });
    await runManagementCycle({ ctx, registry: REGISTRY });
    expect(repo.db.get("Pos1")?.bounce_watch).toBeNull();

    const chain2 = createDryRunChainClient({ clock: CLOCK, seed: { walletSol: 5, positions: [live()] } });
    const ctx2 = makeCtx({ chain: chain2, clock: CLOCK, config: config(smart), repos: { positions: storeRepo([tracked()]) } });
    const out = await runManagementCycle({ ctx: ctx2, registry: REGISTRY });
    expect(out.kind).toBe("executed");
    if (out.kind === "executed") expect(out.plans[0]).toMatchObject({ action: "CLOSE", regime: "CATASTROPHIC" });
  });
});

describe("bounce shadow", () => {
  const closedAt = "2026-10-10T04:00:00.000Z"; // 8h before T0 — past the 6h window
  const closeTs = Math.floor(Date.parse(closedAt) / 1000);
  const perf = (over: Partial<PerformanceRecord> = {}): PerformanceRecord => ({
    position: "PosX",
    pool: "PoolX",
    pool_name: "X-SOL",
    pnl_pct: -18,
    pnl_usd: -6.6,
    fees_earned_usd: 0.66,
    initial_value_usd: 33,
    minutes_held: 400,
    close_reason: "dying (poller): OOR-below + pnl -18.0% ≤ -12%",
    amount_sol: 0.3,
    closed_at: closedAt,
    recorded_at: closedAt,
    ...over,
  });

  it("picks only due, eligible, unstamped closes", () => {
    const now = new Date(T0);
    const due = pickBounceShadowable(
      [
        perf(),
        perf({ position: "Win", close_reason: "take profit" }),
        perf({ position: "Misread", pnl_pct: -0.02, close_reason: "catastrophic: pnl -100.0% ≤ floor -25%" }),
        perf({ position: "Fresh", closed_at: "2026-10-10T08:00:00.000Z" }), // only 4h ago
        perf({ position: "Old", closed_at: "2026-10-01T00:00:00.000Z" }), // > 72h
        perf({ position: "Done", bounce_shadow: {} as PerformanceRecord["bounce_shadow"] }),
      ],
      now,
      360,
    );
    expect(due.map((p) => p.position)).toEqual(["PosX"]);
  });

  it("replays from candles and stamps the record", async () => {
    const kline = createFakeKlineClient();
    kline.set("PoolX", "5m", [
      { t: closeTs - 120, o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: closeTs + 180, o: 1, h: 1.05, l: 0.97, c: 1.02, v: 1 },
      { t: closeTs + 3600, o: 1.1, h: 1.2, l: 1.05, c: 1.18, v: 1 },
    ]);
    const lessons = memLessonRepo();
    await lessons.appendPerformance(perf());
    const ctx = makeCtx({ clock: fixedClock(T0), market: { kline }, repos: { lessons } });
    expect(await runBounceShadow(ctx)).toBe(1);
    const loaded = await lessons.load();
    if (!loaded.ok) throw new Error("load");
    const shadow = loaded.value.performance[0]!.bounce_shadow!;
    expect(shadow.outcome).toBe("take");
    expect(shadow.multiplier).toBeCloseTo(1.15);
    // price leg −20% × 1.15 → 0.92 − 1 + 0.02 fees = −6%
    expect(shadow.shadow_net_pct).toBeCloseTo(-6);
    expect(shadow.delta_pct).toBeCloseTo(12);
    expect(tallyBounceShadow(loaded.value.performance)).toMatchObject({ n: 1, better: 1 });
    expect(await runBounceShadow(ctx)).toBe(0); // never stamped twice
  });

  it("no candles → nothing stamped, gives up after 6 tries", async () => {
    const lessons = memLessonRepo();
    await lessons.appendPerformance(perf());
    const ctx = makeCtx({ clock: fixedClock(T0), repos: { lessons } });
    const attempts = new Map<string, number>();
    for (let i = 0; i < 7; i++) expect(await runBounceShadow(ctx, attempts)).toBe(0);
    expect(attempts.get("PosX")).toBe(6);
  });
});
