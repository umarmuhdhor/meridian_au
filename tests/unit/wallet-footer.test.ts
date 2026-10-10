import { describe, it, expect } from "vitest";
import { nullLogger } from "../../src/ports/logger.js";
import { createWalletFooter, formatWalletFooter, realizedPnlSol } from "../../src/app/notify/wallet-footer.ts";
import type { PerformanceRecord } from "../../src/domain/schemas/lesson.ts";
import type { ChainClient } from "../../src/ports/chain-client.ts";
import type { LessonRepo } from "../../src/ports/lesson-repo.ts";

const rec = (p: Partial<PerformanceRecord>): PerformanceRecord =>
  ({ position: "P", pnl_pct: 0, close_reason: "x", ...p }) as PerformanceRecord;

describe("realizedPnlSol", () => {
  it("uses amount_sol × net pnl_pct", () => {
    expect(realizedPnlSol(rec({ amount_sol: 0.5, pnl_pct: -10 }), 200)).toBeCloseTo(-0.05);
  });
  it("falls back to net USD at the current SOL price", () => {
    expect(realizedPnlSol(rec({ pnl_usd: -30, fees_earned_usd: 10, pnl_pct: -5 }), 200)).toBeCloseTo(-0.1);
  });
  it("returns null when nothing is usable", () => {
    expect(realizedPnlSol(rec({ pnl_pct: -5 }), 200)).toBeNull();
  });
});

describe("formatWalletFooter", () => {
  it("shows total balance, loss sum and net", () => {
    const text = formatWalletFooter({
      wallet_sol: 1.2,
      sol_price: 100,
      positions_sol: 0.3,
      open_positions: 1,
      performance: [
        rec({ amount_sol: 0.3, pnl_pct: -10 }),
        rec({ amount_sol: 0.3, pnl_pct: -20 }),
        rec({ amount_sol: 0.3, pnl_pct: 50 }),
      ],
    });
    expect(text).toContain("Sisa saldo: 1.5 SOL ≈ $150.00 (dompet 1.2 + 1 posisi 0.3)");
    expect(text).toContain("Total rugi: -0.09 SOL (2 posisi rugi) · Net: +0.06 SOL");
    expect(text).not.toMatch(/[<>&]/);
  });
});

describe("createWalletFooter", () => {
  const lessons = { recentPerformance: async () => [rec({ amount_sol: 1, pnl_pct: -10 })] } as unknown as LessonRepo;

  it("sums open positions into the balance", async () => {
    const chain = {
      getWalletBalance: async () => ({ sol: 2, sol_usd: 200, sol_price: 100, fetched_at: "" }),
      getMyPositions: async () => ({
        total_positions: 1,
        fetched_at: "",
        positions: [{ total_value_usd: 40, unclaimed_fees_usd: 10 }],
      }),
    } as unknown as ChainClient;
    const text = await createWalletFooter({ chain, lessons, logger: nullLogger })();
    expect(text).toContain("Sisa saldo: 2.5 SOL");
    expect(text).toContain("Total rugi: -0.1 SOL (1 posisi rugi)");
  });

  it("resolves null when the balance read fails", async () => {
    const chain = {
      getWalletBalance: async () => {
        throw new Error("rpc");
      },
      getMyPositions: async () => ({ total_positions: 0, fetched_at: "", positions: [] }),
    } as unknown as ChainClient;
    expect(await createWalletFooter({ chain, lessons, logger: nullLogger })()).toBeNull();
  });

  it("resolves null on timeout", async () => {
    const chain = {
      getWalletBalance: () => new Promise(() => {}),
      getMyPositions: async () => ({ total_positions: 0, fetched_at: "", positions: [] }),
    } as unknown as ChainClient;
    expect(await createWalletFooter({ chain, lessons, logger: nullLogger, timeoutMs: 20 })()).toBeNull();
  });
});
