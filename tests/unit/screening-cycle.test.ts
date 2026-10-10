import { describe, it, expect } from "vitest";
import { runScreeningCycle } from "../../src/app/screening/cycle.js";
import { createRegistry } from "../../src/app/tools/registry.js";
import { createFakeLLM } from "../../src/adapters/llm/fake.js";
import { createFakePoolDiscovery } from "../../src/adapters/market/fake-pool-discovery.js";
import { createDryRunChainClient } from "../../src/adapters/chain/dry-run.js";
import { fixedClock } from "../../src/ports/clock.js";
import { getTopCandidatesTool } from "../../src/app/tools/impls/get-top-candidates.js";
import { getWalletBalanceTool } from "../../src/app/tools/impls/get-wallet-balance.js";
import { getMyPositionsTool } from "../../src/app/tools/impls/get-my-positions.js";
import { assertPoolDeployableTool } from "../../src/app/tools/impls/assert-pool-deployable.js";
import { deployPositionTool } from "../../src/app/tools/impls/deploy-position.js";
import type { CandidatePool } from "../../src/domain/schemas/market.js";
import type { OnChainPosition } from "../../src/domain/schemas/chain.js";
import type { KlineCandle } from "../../src/domain/schemas/kline.js";
import type { Lesson } from "../../src/domain/schemas/lesson.js";
import { createFakeKlineClient } from "../../src/adapters/market/fake-kline.js";
import { makeCtx } from "./tool-context.js";

function pool(over: Partial<CandidatePool> = {}): CandidatePool {
  return {
    pool_address: "goodPool",
    name: "GOOD/SOL",
    base_mint: "MINT_G",
    quote_mint: "So11111111111111111111111111111111111111112",
    tvl: 50_000,
    active_tvl: 40_000,
    volume_window: 20_000,
    fee_active_tvl_ratio: 0.12,
    fee_tvl_ratio: 0.1,
    organic_score: 80,
    holders: 1500,
    mcap: 500_000,
    bin_step: 100,
    volatility: 0.05,
    launchpad: null,
    token_age_hours: 24,
    active_pct: 60,
    ...over,
  };
}

const REGISTRY = createRegistry([
  getTopCandidatesTool,
  getWalletBalanceTool,
  getMyPositionsTool,
  assertPoolDeployableTool,
  deployPositionTool,
]);

const CLOCK = fixedClock("2026-07-05T12:00:00.000Z");

/**
 * 20 declining candles: window high = 100, last close = `endClose`, so
 * from_window_high_pct = (endClose - 100) / 100 * 100. endClose=50 → -50%.
 * Only 20 candles (< emaLong 50) so trend is null — proving the drawdown gate
 * is trend-INDEPENDENT (the Zoe/GTA6/Morty dead-cat-bounce hole).
 */
function fallingSeries(endClose: number, startHigh = 100): KlineCandle[] {
  const out: KlineCandle[] = [];
  const step = (startHigh - endClose) / 19;
  for (let i = 0; i < 20; i++) {
    const c = startHigh - i * step;
    out.push({ t: 1_700_000_000 + i * 3600, o: c, h: i === 0 ? startHigh : c, l: c, c, v: 1000 });
  }
  return out;
}

describe("runScreeningCycle", () => {
  it("skips at max positions with decision log entry", async () => {
    // Seed chain with 3 positions (config.risk.maxPositions = 3)
    const positions: OnChainPosition[] = Array.from({ length: 3 }, (_, i) => ({
      position: `p${i}`,
      pool: `pool${i}`,
      pair: `p${i}/SOL`,
      base_mint: `M${i}`,
      lower_bin: 0,
      upper_bin: 10,
      active_bin: 5,
      in_range: true,
      unclaimed_fees_usd: 0,
      pnl_pct: 0,
      pnl_pct_suspicious: false,
    }));
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { walletSol: 5, positions } });
    const ctx = makeCtx({ chain });
    const llm = createFakeLLM({ script: [] });
    const outcome = await runScreeningCycle({ ctx, llm, registry: REGISTRY, model: "test" });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") expect(outcome.reason).toContain("max positions");
    const ds = await ctx.repos.decisions.recent(1);
    expect(ds[0]?.type).toBe("skip");
  });

  it("skips on insufficient SOL", async () => {
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { walletSol: 0.3 } });
    const ctx = makeCtx({ chain });
    const llm = createFakeLLM({ script: [] });
    const outcome = await runScreeningCycle({ ctx, llm, registry: REGISTRY, model: "test" });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") expect(outcome.reason).toContain("insufficient SOL");
  });

  it("no_deploy when 0 candidates pass", async () => {
    const pools = createFakePoolDiscovery({ seed: [pool({ tvl: 100 })] });
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { walletSol: 5 } });
    const ctx = makeCtx({ chain, market: { pools } });
    const llm = createFakeLLM({ script: [] });
    const outcome = await runScreeningCycle({ ctx, llm, registry: REGISTRY, model: "test" });
    expect(outcome.kind).toBe("no_deploy");
    if (outcome.kind === "no_deploy") {
      expect(outcome.picked).toBe(0);
      expect(outcome.rejection_summary[0]).toContain("tvl_out_of_range");
    }
    const ds = await ctx.repos.decisions.recent(1);
    expect(ds[0]?.type).toBe("no_deploy");
  });

  it("rejects a both-TF-DOWN candidate with no support floor (no_floor_downtrend gate)", async () => {
    // QENIS repro: both timeframes trending DOWN, no swing-low support (monotonic
    // decline → current close is the lowest → nearest_support null), but shallow
    // from_high so the drawdown gate does NOT fire — the no-floor gate must catch it.
    // 60 candles 100→82: enough for EMA50 (trend=DOWN), monotonic (no swing low).
    const decline: KlineCandle[] = Array.from({ length: 60 }, (_, i) => {
      const c = 100 - i * ((100 - 82) / 59);
      return { t: 1_700_000_000 + i * 3600, o: c, h: c * 1.003, l: c * 0.997, c, v: 1000 };
    });
    const pools = createFakePoolDiscovery({
      seed: [pool({ pool_address: "knifePool", name: "KNIFE/SOL", base_mint: "MINT_K" })],
    });
    const kline = createFakeKlineClient();
    kline.set("knifePool", "15m", decline);
    kline.set("knifePool", "1h", decline);
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { walletSol: 5 } });
    const ctx = makeCtx({ chain, market: { pools, kline } });
    const llm = createFakeLLM({ script: [] });
    const outcome = await runScreeningCycle({ ctx, llm, registry: REGISTRY, model: "test" });
    expect(outcome.kind).toBe("no_deploy");
    if (outcome.kind === "no_deploy") {
      expect(outcome.rejection_summary).toContain("ta_no_floor_downtrend");
    }
  });

  it("rejects a candidate deep below its window high regardless of trend (drawdown gate)", async () => {
    // Zoe/GTA6/Morty repro: token -50% from window high, bought on a bounce.
    // Trend is null here (only 20 candles), proving the gate does NOT depend on
    // trend=DOWN — the exact hole that let the dead-cat-bounce entries through.
    const pools = createFakePoolDiscovery({
      seed: [pool({ pool_address: "deepPool", name: "DEEP/SOL", base_mint: "MINT_D" })],
    });
    const kline = createFakeKlineClient();
    kline.set("deepPool", "15m", fallingSeries(50));
    kline.set("deepPool", "1h", fallingSeries(50));
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { walletSol: 5 } });
    const ctx = makeCtx({ chain, market: { pools, kline } });
    const llm = createFakeLLM({ script: [] });
    const outcome = await runScreeningCycle({ ctx, llm, registry: REGISTRY, model: "test" });
    expect(outcome.kind).toBe("no_deploy");
    if (outcome.kind === "no_deploy") {
      expect(outcome.picked).toBe(0);
      expect(outcome.rejection_summary).toContain("ta_drawdown");
    }
  });

  it("invokes agent when candidates pass", async () => {
    const pools = createFakePoolDiscovery({ seed: [pool()] });
    const chain = createDryRunChainClient({ clock: CLOCK, seed: { walletSol: 5 } });
    const ctx = makeCtx({ chain, market: { pools } });
    const llm = createFakeLLM({
      script: [
        {
          kind: "tool_calls",
          calls: [{
            name: "deploy_position",
            args: {
              pool_address: "goodPool",
              amount_sol: 0.5,
              strategy: "bid_ask",
              bins_below: 40,
              bins_above: 10,
              base_mint: "MINT_G",
            },
          }],
        },
        { kind: "assistant", text: "deployed" },
      ],
    });
    const outcome = await runScreeningCycle({ ctx, llm, registry: REGISTRY, model: "test" });
    expect(outcome.kind).toBe("invoked");
    if (outcome.kind === "invoked") {
      expect(outcome.picked).toBe(1);
      expect(outcome.agent.finishReason).toBe("stop");
      const deployCall = outcome.agent.toolCalls.find((t) => t.name === "deploy_position");
      expect(deployCall?.ok).toBe(true);
    }
    // Decision log received deploy entry via post-hook
    const ds = await ctx.repos.decisions.recent(1);
    expect(ds[0]?.type).toBe("deploy");
  });

  describe("community backup lessons", () => {
    const backupMatched: Lesson = {
      id: "c-thin",
      rule: "CAUTION thin pool",
      tags: ["community"],
      pinned: false,
      sourceType: "community",
      outcome: "loss",
      match: "tvl < 20000 AND mcap < 1000000",
    };
    const backupGeneral: Lesson = {
      id: "c-rug",
      rule: "a stop cannot save a fast rug",
      tags: ["community"],
      pinned: false,
      sourceType: "community",
      outcome: "loss",
    };

    async function promptsFor(lessons: Lesson[]): Promise<{ system: string; goal: string }> {
      const pools = createFakePoolDiscovery({ seed: [pool({ tvl: 15_000, active_tvl: 12_000 })] });
      const chain = createDryRunChainClient({ clock: CLOCK, seed: { walletSol: 5 } });
      const ctx = makeCtx({ chain, market: { pools } });
      for (const l of lessons) await ctx.repos.lessons.addLesson(l);
      const llm = createFakeLLM({ script: [{ kind: "assistant", text: "no deploy" }, { kind: "assistant", text: "no deploy" }] });
      await runScreeningCycle({ ctx, llm, registry: REGISTRY, model: "test" });
      const req = llm.requests()[0]!;
      const text = (role: string) =>
        req.messages.filter((m) => m.role === role).map((m) => String(m.content)).join("\n");
      return { system: text("system"), goal: text("user") };
    }

    it("puts a matching community lesson on a candidate our own lessons do not cover", async () => {
      const { system, goal } = await promptsFor([backupMatched, backupGeneral]);
      expect(goal).toContain("tvl=$15000");
      expect(goal).toMatch(/backup: +↳ \[c-thin\] CAUTION thin pool {2}\(our data: untested/);
      expect(system).toContain("── COMMUNITY BACKUP ──");
      expect(system).toContain("[c-rug]");
      // Never in our own LESSONS block.
      expect(system.split("── COMMUNITY BACKUP ──")[0]).not.toContain("c-rug");
    });

    it("stays silent where one of our own lessons holds for the candidate", async () => {
      const ownLesson: Lesson = { id: "o-thin", rule: "own rule", tags: [], pinned: false, match: "tvl < 30000 AND mcap < 900000" };
      const { goal } = await promptsFor([backupMatched, ownLesson]);
      expect(goal).toContain("[o-thin]");
      expect(goal).not.toContain("c-thin");
    });
  });
});
