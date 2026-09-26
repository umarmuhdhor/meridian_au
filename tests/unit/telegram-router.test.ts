import { describe, it, expect } from "vitest";
import type { InboundMessage } from "../../src/ports/telegram-inbound.js";
import type { LLMClient } from "../../src/ports/llm-client.js";
import type { ToolRegistry } from "../../src/app/tools/registry.js";
import { routeTelegramMessage } from "../../src/app/telegram/router.js";
import { createManualScheduler } from "../../src/adapters/scheduler/manual.js";
import { createDryRunChainClient } from "../../src/adapters/chain/dry-run.js";
import { createCollectingNotifier, type CollectingNotifier } from "../../src/adapters/notify/collecting-notifier.js";
import { fixedClock } from "../../src/ports/clock.js";
import { makeCtx } from "./tool-context.js";
import { createRegistry } from "../../src/app/tools/registry.js";
import { closePositionTool } from "../../src/app/tools/impls/close-position.js";

const throwingLlm: LLMClient = {
  chat: async () => {
    throw new Error("LLM should not be invoked for control commands");
  },
};

// /close and /closeall go through the close_position tool (History + decision log).
const closeRegistry = createRegistry([closePositionTool]);

const emptyRegistry: ToolRegistry = {
  list: () => [],
  get: () => null,
  names: () => [],
};

function msg(text: string): InboundMessage {
  return {
    chatId: "chat",
    chatType: "private",
    userId: "user",
    username: "op",
    text,
    timestampMs: 0,
  };
}

function notifyTexts(n: CollectingNotifier): string[] {
  return n.recorded
    .filter((r): r is { type: "notify"; kind: "info" | "warn" | "error"; text: string } => r.type === "notify")
    .map((r) => r.text);
}

describe("routeTelegramMessage — control commands", () => {
  it("/pause suspends scheduler and acks", async () => {
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ notifier });
    const scheduler = createManualScheduler();
    scheduler.every(100, () => {}, "noop");

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x", scheduler },
      msg("/pause"),
    );

    expect(scheduler.isPaused()).toBe(true);
    expect(notifyTexts(notifier).join("\n")).toMatch(/paused/i);
  });

  it("/pause on already-paused reports state without re-pausing", async () => {
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ notifier });
    const scheduler = createManualScheduler();
    scheduler.pause();

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x", scheduler },
      msg("/pause"),
    );

    expect(scheduler.isPaused()).toBe(true);
    expect(notifyTexts(notifier).join("\n")).toMatch(/already paused/i);
  });

  it("/resume unpauses scheduler and acks", async () => {
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ notifier });
    const scheduler = createManualScheduler();
    scheduler.pause();

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x", scheduler },
      msg("/resume"),
    );

    expect(scheduler.isPaused()).toBe(false);
    expect(notifyTexts(notifier).join("\n")).toMatch(/resumed/i);
  });

  it("/resume on unpaused reports state", async () => {
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ notifier });
    const scheduler = createManualScheduler();

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x", scheduler },
      msg("/resume"),
    );

    expect(scheduler.isPaused()).toBe(false);
    expect(notifyTexts(notifier).join("\n")).toMatch(/already running/i);
  });

  it("/stop invokes shutdown fn with a reason and acks", async () => {
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ notifier });
    const scheduler = createManualScheduler();
    let stopped: string | null = null;
    const shutdown = (reason: string) => {
      stopped = reason;
    };

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x", scheduler, shutdown },
      msg("/stop"),
    );

    expect(stopped).toMatch(/telegram/i);
    expect(notifyTexts(notifier).join("\n")).toMatch(/shutting down/i);
  });

  it("/pause without scheduler dep reports unavailable", async () => {
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ notifier });

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x" },
      msg("/pause"),
    );

    expect(notifyTexts(notifier).join("\n")).toMatch(/unavailable/i);
  });

  it("/stop without shutdown dep reports unavailable", async () => {
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ notifier });

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x" },
      msg("/stop"),
    );

    expect(notifyTexts(notifier).join("\n")).toMatch(/unavailable/i);
  });

  it("/close without writesEnabled refuses without touching chain", async () => {
    const notifier = createCollectingNotifier();
    const clock = fixedClock("2026-07-05T12:00:00.000Z");
    const chain = createDryRunChainClient({
      clock,
      seed: {
        positions: [
          {
            position: "POS_ONE_1111111111111111111111111",
            pool: "POOL_A",
            base_mint: "BASE_A",
            pair: "AAA/SOL",
            in_range: true,
            active_bin: 100,
            lower_bin: 90,
            upper_bin: 110,
            amount_sol: 1,
            total_value_usd: 150,
            pnl_pct: 0,
            pnl_pct_suspicious: false,
            deployed_at: "2026-07-05T12:00:00.000Z",
            unclaimed_fees_usd: 0,
          },
        ],
      },
    });
    const ctx = makeCtx({ notifier, chain });

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x" /* writesEnabled omitted */ },
      msg("/close 1"),
    );

    expect(notifyTexts(notifier).join("\n")).toMatch(/writes not armed|refused/i);
    // Position still exists — chain not touched.
    expect(chain.peekPositions()).toHaveLength(1);
  });

  it("/close <n> closes the Nth position when writesEnabled", async () => {
    const notifier = createCollectingNotifier();
    const clock = fixedClock("2026-07-05T12:00:00.000Z");
    const chain = createDryRunChainClient({
      clock,
      seed: {
        positions: [
          {
            position: "POS_ONE_1111111111111111111111111",
            pool: "POOL_A",
            base_mint: "BASE_A",
            pair: "AAA/SOL",
            in_range: true,
            active_bin: 100,
            lower_bin: 90,
            upper_bin: 110,
            amount_sol: 1,
            total_value_usd: 150,
            pnl_pct: 0,
            pnl_pct_suspicious: false,
            deployed_at: "2026-07-05T12:00:00.000Z",
            unclaimed_fees_usd: 0,
          },
          {
            position: "POS_TWO_2222222222222222222222222",
            pool: "POOL_B",
            base_mint: "BASE_B",
            pair: "BBB/SOL",
            in_range: true,
            active_bin: 100,
            lower_bin: 90,
            upper_bin: 110,
            amount_sol: 1,
            total_value_usd: 150,
            pnl_pct: 0,
            pnl_pct_suspicious: false,
            deployed_at: "2026-07-05T12:00:00.000Z",
            unclaimed_fees_usd: 0,
          },
        ],
      },
    });
    const ctx = makeCtx({ notifier, chain });

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: closeRegistry, model: "x", writesEnabled: true },
      msg("/close 2"),
    );

    expect(chain.peekPositions().map((p) => p.position)).toEqual([
      "POS_ONE_1111111111111111111111111",
    ]);
    const closes = notifier.recorded.filter((r) => r.type === "close");
    expect(closes.length).toBe(1);
    expect(closes[0]).toMatchObject({ type: "close", result: { pair: "BBB/SOL", success: true } });
  });

  it("/close with bad index reports without touching chain", async () => {
    const notifier = createCollectingNotifier();
    const clock = fixedClock("2026-07-05T12:00:00.000Z");
    const chain = createDryRunChainClient({
      clock,
      seed: { positions: [] },
    });
    const ctx = makeCtx({ notifier, chain });

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x", writesEnabled: true },
      msg("/close 5"),
    );

    expect(notifyTexts(notifier).join("\n")).toMatch(/No position at index 5/);
  });

  it("/closeall closes every open position when writesEnabled", async () => {
    const notifier = createCollectingNotifier();
    const clock = fixedClock("2026-07-05T12:00:00.000Z");
    const chain = createDryRunChainClient({
      clock,
      seed: {
        positions: [
          {
            position: "POS_ONE_1111111111111111111111111",
            pool: "POOL_A",
            base_mint: "BASE_A",
            pair: "AAA/SOL",
            in_range: true,
            active_bin: 100,
            lower_bin: 90,
            upper_bin: 110,
            amount_sol: 1,
            total_value_usd: 150,
            pnl_pct: 0,
            pnl_pct_suspicious: false,
            deployed_at: "2026-07-05T12:00:00.000Z",
            unclaimed_fees_usd: 0,
          },
          {
            position: "POS_TWO_2222222222222222222222222",
            pool: "POOL_B",
            base_mint: "BASE_B",
            pair: "BBB/SOL",
            in_range: true,
            active_bin: 100,
            lower_bin: 90,
            upper_bin: 110,
            amount_sol: 1,
            total_value_usd: 150,
            pnl_pct: 0,
            pnl_pct_suspicious: false,
            deployed_at: "2026-07-05T12:00:00.000Z",
            unclaimed_fees_usd: 0,
          },
        ],
      },
    });
    const ctx = makeCtx({ notifier, chain });

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: closeRegistry, model: "x", writesEnabled: true },
      msg("/closeall"),
    );

    expect(chain.peekPositions()).toHaveLength(0);
    const text = notifyTexts(notifier).join("\n");
    expect(text).toMatch(/success=2/);
    expect(text).toMatch(/failed=0/);
  });

  it("/deploy without writesEnabled refuses without touching chain", async () => {
    const notifier = createCollectingNotifier();
    const clock = fixedClock("2026-07-05T12:00:00.000Z");
    const chain = createDryRunChainClient({ clock, seed: { positions: [], walletSol: 10 } });
    const ctx = makeCtx({ notifier, chain });

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x" },
      msg("/deploy POOL_XYZ 1.5"),
    );

    expect(notifyTexts(notifier).join("\n")).toMatch(/writes not armed|refused/i);
    expect(chain.peekPositions()).toHaveLength(0);
  });

  it("/deploy <pool> [sol] opens a position with config strategy/bins", async () => {
    const notifier = createCollectingNotifier();
    const clock = fixedClock("2026-07-05T12:00:00.000Z");
    const chain = createDryRunChainClient({
      clock,
      seed: {
        positions: [],
        walletSol: 10,
        activeBins: { POOL_XYZ: { binId: 200, price: 0.02, pricePerLamport: "1" } },
      },
    });
    const ctx = makeCtx({ notifier, chain });

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x", writesEnabled: true },
      msg("/deploy POOL_XYZ 1.25"),
    );

    const positions = chain.peekPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.pool).toBe("POOL_XYZ");
    expect(positions[0]?.amount_sol).toBeCloseTo(1.25, 5);
    expect(notifyTexts(notifier).join("\n")).toMatch(/Deployed/);
  });

  it("/deploy without pool address prints usage", async () => {
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ notifier });

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x", writesEnabled: true },
      msg("/deploy"),
    );

    expect(notifyTexts(notifier).join("\n")).toMatch(/Usage: \/deploy/);
  });

  it("/help mentions the new control commands", async () => {
    const notifier = createCollectingNotifier();
    const ctx = makeCtx({ notifier });

    await routeTelegramMessage(
      { ctx, llm: throwingLlm, registry: emptyRegistry, model: "x" },
      msg("/help"),
    );

    const text = notifyTexts(notifier).join("\n");
    expect(text).toMatch(/\/pause/);
    expect(text).toMatch(/\/resume/);
    expect(text).toMatch(/\/stop/);
  });
});
