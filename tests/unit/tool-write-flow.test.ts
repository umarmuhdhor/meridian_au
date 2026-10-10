import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/app/tools/registry.js";
import { executeTool } from "../../src/app/tools/execute.js";
import { deployPositionTool } from "../../src/app/tools/impls/deploy-position.js";
import { closePositionTool } from "../../src/app/tools/impls/close-position.js";
import { claimFeesTool } from "../../src/app/tools/impls/claim-fees.js";
import { swapTokenTool } from "../../src/app/tools/impls/swap-token.js";
import { addToBlacklistTool } from "../../src/app/tools/impls/add-to-blacklist.js";
import { createDryRunChainClient } from "../../src/adapters/chain/dry-run.js";
import { createCollectingNotifier } from "../../src/adapters/notify/collecting-notifier.js";
import { fixedClock } from "../../src/ports/clock.js";
import type { PoolMemoryEntry } from "../../src/domain/schemas/pool-memory.js";
import type { TrackedPosition } from "../../src/domain/schemas/position.js";
import type { PositionRepo } from "../../src/ports/position-repo.js";
import { makeCtx, memPoolMemoryRepo, memLessonRepo, memDecisionLog, memStrategyRepo, memSmartWalletRepo, memTokenBlacklistRepo, memSwapClient } from "./tool-context.js";

const NOW = "2026-07-05T12:00:00.000Z";
const FUTURE = "2026-07-05T18:00:00.000Z";

// Stateful in-memory position repo so post-deploy persistence is observable
// (the shared memPositionRepo() is a no-op stub).
function statefulPositionRepo(): PositionRepo {
  const store = new Map<string, TrackedPosition>();
  return {
    async load() {
      return { ok: true, value: { positions: Object.fromEntries(store), recentEvents: [], lastUpdated: null } };
    },
    async save() {},
    async get(addr) {
      return store.get(addr) ?? null;
    },
    async all(openOnly) {
      const xs = [...store.values()];
      return openOnly ? xs.filter((x) => !x.closed) : xs;
    },
    async upsert(pos) {
      store.set(pos.position, pos);
    },
    async pushEvent() {},
  };
}

function fullyMemCtx(over: {
  walletSol?: number;
  poolMemory?: Record<string, PoolMemoryEntry>;
} = {}) {
  const clock = fixedClock(NOW);
  const chain = createDryRunChainClient({ clock, seed: { walletSol: over.walletSol ?? 5 } });
  const notifier = createCollectingNotifier();
  const decisions = memDecisionLog();
  return {
    ctx: makeCtx({
      clock,
      chain,
      swap: memSwapClient(),
      notifier,
      repos: {
        positions: statefulPositionRepo(),
        poolMemory: memPoolMemoryRepo(over.poolMemory ?? {}),
        lessons: memLessonRepo(),
        decisions,
        strategies: memStrategyRepo(),
        smartWallets: memSmartWalletRepo(),
        tokenBlacklist: memTokenBlacklistRepo(),
      },
    }),
    notifier,
    decisions,
    chain,
  };
}

describe("deploy_position — safety chain + post-hooks", () => {
  it("success path: notifier notified, decision appended, wallet decremented", async () => {
    const { ctx, notifier, decisions, chain } = fullyMemCtx({ walletSol: 5 });
    const r = await executeTool(createRegistry([deployPositionTool]), {
      name: "deploy_position",
      args: {
        pool_address: "poolA",
        amount_sol: 0.5,
        strategy: "bid_ask",
        bins_below: 40,
        bins_above: 10,
        pool_name: "TKN/SOL",
      },
    }, ctx);
    expect(r.ok).toBe(true);
    // notifier fanout
    expect(notifier.recorded.some((e) => e.type === "deploy")).toBe(true);
    // decision log
    const d = await decisions.recent(1);
    expect(d[0]?.type).toBe("deploy");
    expect(d[0]?.pool).toBe("poolA");
    // wallet decremented
    const b = await chain.getWalletBalance();
    expect(b.sol).toBe(4.5);
    // position persisted to the tracking store (trailing-TP / age rules depend on it)
    const tracked = await ctx.repos.positions.all();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.strategy).toBe("bid_ask");
    expect(tracked[0]?.pool_name).toBe("TKN/SOL");
    expect(tracked[0]?.closed).toBe(false);
  });

  it("carries reason + lessons_applied from deploy through to the performance record", async () => {
    const { ctx, decisions } = fullyMemCtx({ walletSol: 5 });
    const registry = createRegistry([deployPositionTool, closePositionTool]);
    const r = await executeTool(registry, {
      name: "deploy_position",
      args: {
        pool_address: "poolA",
        amount_sol: 0.5,
        strategy: "spot",
        bins_below: 40,
        pool_name: "TKN/SOL",
        reason: "fee/tvl 0.12 sideways chop, spot for two-way swings",
        lessons_applied: ["l-1", "l-2"],
      },
    }, ctx);
    expect(r.ok).toBe(true);
    const [dec] = await decisions.recent(1);
    expect(dec?.reason).toBe("fee/tvl 0.12 sideways chop, spot for two-way swings");
    expect(dec?.metrics.lessons_applied).toEqual(["l-1", "l-2"]);

    const [tracked] = await ctx.repos.positions.all();
    expect(tracked?.lessons_applied).toEqual(["l-1", "l-2"]);

    const c = await executeTool(registry, {
      name: "close_position",
      args: { position_address: tracked!.position, reason: "take profit" },
    }, ctx);
    expect(c.ok).toBe(true);
    const [rec] = await ctx.repos.lessons.recentPerformance(1);
    expect(rec?.entry_reason).toBe("fee/tvl 0.12 sideways chop, spot for two-way swings");
    expect(rec?.lessons_applied).toEqual(["l-1", "l-2"]);
  });

  it("blocked by pool cooldown → no notify, no decision, no wallet change", async () => {
    const { ctx, notifier, decisions, chain } = fullyMemCtx({
      walletSol: 5,
      poolMemory: {
        poolA: {
          name: "TKN/SOL",
          base_mint: "MINT_A",
          deploys: [],
          total_deploys: 0,
          avg_pnl_pct: 0,
          win_rate: 0,
          adjusted_win_rate: 0,
          adjusted_win_rate_sample_count: 0,
          last_deployed_at: null,
          last_outcome: null,
          cooldown_until: FUTURE,
          cooldown_reason: "low yield",
          notes: [],
          snapshots: [],
        },
      },
    });
    const r = await executeTool(createRegistry([deployPositionTool]), {
      name: "deploy_position",
      args: {
        pool_address: "poolA",
        amount_sol: 0.5,
        strategy: "bid_ask",
        bins_below: 40,
      },
    }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("safety_blocked");
    expect(notifier.recorded).toHaveLength(0);
    expect(await decisions.recent(1)).toHaveLength(0);
    const b = await chain.getWalletBalance();
    expect(b.sol).toBe(5);
  });

  it("blocked by wallet balance → safety_blocked reason mentions balance", async () => {
    const { ctx } = fullyMemCtx({ walletSol: 0.3 });
    const r = await executeTool(createRegistry([deployPositionTool]), {
      name: "deploy_position",
      args: {
        pool_address: "poolA",
        amount_sol: 0.5,
        strategy: "bid_ask",
        bins_below: 40,
      },
    }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "safety_blocked") {
      expect(r.error.reason).toContain("SOL");
    } else {
      throw new Error("expected safety_blocked");
    }
  });

  it("blocked by token blacklist (base_mint)", async () => {
    const { ctx } = fullyMemCtx({ walletSol: 5 });
    await ctx.repos.tokenBlacklist.add("MINT_A", {
      symbol: "TKN",
      reason: "rug",
      added_at: NOW,
      added_by: "test",
    });
    const r = await executeTool(createRegistry([deployPositionTool]), {
      name: "deploy_position",
      args: {
        pool_address: "poolA",
        amount_sol: 0.5,
        strategy: "bid_ask",
        bins_below: 40,
        base_mint: "MINT_A",
      },
    }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "safety_blocked") {
      expect(r.error.reason).toMatch(/blacklisted/);
    } else {
      throw new Error("expected safety_blocked");
    }
  });

  it("bins_below < 35 rejected at args validation (safety floor)", async () => {
    const { ctx } = fullyMemCtx({ walletSol: 5 });
    const r = await executeTool(createRegistry([deployPositionTool]), {
      name: "deploy_position",
      args: {
        pool_address: "poolA",
        amount_sol: 0.5,
        strategy: "bid_ask",
        bins_below: 20,
      },
    }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("args_invalid");
  });
});

describe("close_position + claim_fees + swap_token — post-hooks", () => {
  it("close success → notifier + decision log", async () => {
    const { ctx, notifier, decisions, chain } = fullyMemCtx({ walletSol: 5 });
    // Deploy first via chain directly
    const deploy = await chain.deployPosition({
      pool_address: "poolA",
      amount_sol: 1,
      strategy: "bid_ask",
      bins_below: 40,
      bins_above: 0,
    });
    notifier.clear();

    const r = await executeTool(createRegistry([closePositionTool]), {
      name: "close_position",
      args: { position_address: deploy.position_address, reason: "test close" },
    }, ctx);
    expect(r.ok).toBe(true);
    expect(notifier.recorded.some((e) => e.type === "close")).toBe(true);
    const ds = await decisions.recent(1);
    expect(ds[0]?.type).toBe("close");
  });

  it("close success → base token auto-swapped to SOL via post-hook", async () => {
    const { ctx, notifier, chain } = fullyMemCtx({ walletSol: 5 });
    const deploy = await chain.deployPosition({
      pool_address: "poolA",
      amount_sol: 1,
      strategy: "bid_ask",
      bins_below: 40,
      bins_above: 0,
    });
    const [pos] = chain.peekPositions();
    if (!pos) throw new Error("expected position");
    chain.setState({ positions: [{ ...pos, base_mint: "MINT_BASE" }] });
    // Teach the chain to report the withdrawn base token sitting in the wallet.
    (chain as unknown as { getWalletTokens: () => Promise<unknown> }).getWalletTokens = async () => [
      { mint: "MINT_BASE", symbol: null, balance: 1000, raw: "1000000000", usd: 50 },
    ];
    notifier.clear();

    const r = await executeTool(createRegistry([closePositionTool]), {
      name: "close_position",
      args: { position_address: deploy.position_address, reason: "test close" },
    }, ctx);
    expect(r.ok).toBe(true);
    // The consolidation swap fired (base → SOL) as a post-hook side-effect.
    expect(notifier.recorded.some((e) => e.type === "swap")).toBe(true);
  });

  it("claim success → notifier claim event", async () => {
    const { ctx, notifier, chain } = fullyMemCtx({ walletSol: 5 });
    const deploy = await chain.deployPosition({
      pool_address: "poolA",
      amount_sol: 1,
      strategy: "bid_ask",
      bins_below: 40,
      bins_above: 0,
    });
    const [pos] = chain.peekPositions();
    if (!pos) throw new Error("expected position");
    chain.setState({ positions: [{ ...pos, unclaimed_fees_usd: 3.5 }] });
    notifier.clear();

    const r = await executeTool(createRegistry([claimFeesTool]), {
      name: "claim_fees",
      args: { position_address: deploy.position_address },
    }, ctx);
    expect(r.ok).toBe(true);
    expect(notifier.recorded.some((e) => e.type === "claim")).toBe(true);
  });

  it("swap success → notifier swap event", async () => {
    const { ctx, notifier } = fullyMemCtx();
    const r = await executeTool(createRegistry([swapTokenTool]), {
      name: "swap_token",
      args: { input_mint: "MINT_A", output_mint: "SOL", amount_in: 100 },
    }, ctx);
    expect(r.ok).toBe(true);
    expect(notifier.recorded.some((e) => e.type === "swap")).toBe(true);
  });
});

describe("add_to_blacklist", () => {
  it("adds entry and downstream deploy blocked", async () => {
    const { ctx } = fullyMemCtx({ walletSol: 5 });
    const add = await executeTool(createRegistry([addToBlacklistTool]), {
      name: "add_to_blacklist",
      args: { mint: "MINT_Z", reason: "smells like rug" },
    }, ctx);
    expect(add.ok).toBe(true);
    expect(await ctx.repos.tokenBlacklist.isBlacklisted("MINT_Z")).toBe(true);

    const deploy = await executeTool(createRegistry([deployPositionTool]), {
      name: "deploy_position",
      args: {
        pool_address: "poolA",
        amount_sol: 0.5,
        strategy: "bid_ask",
        bins_below: 40,
        base_mint: "MINT_Z",
      },
    }, ctx);
    expect(deploy.ok).toBe(false);
    if (!deploy.ok && deploy.error.kind === "safety_blocked") {
      expect(deploy.error.reason).toMatch(/blacklisted/);
    } else {
      throw new Error("expected safety_blocked");
    }
  });
});
