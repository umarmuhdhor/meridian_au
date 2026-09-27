import { describe, it, expect, vi } from "vitest";
import { estimateClosePnl, settledClosePnl } from "../../src/domain/format/close-pnl.js";
import { enrichCloseResult } from "../../src/domain/format/enrich-close.js";
import { finalizeClosedPerformance, FINALIZE_MAX_PER_TICK } from "../../src/app/management/finalize-performance.js";
import { createDryRunChainClient } from "../../src/adapters/chain/dry-run.js";
import type { CloseResult, ClosedPositionPnl, OnChainPosition } from "../../src/domain/schemas/chain.js";
import type { PerformanceRecord } from "../../src/domain/schemas/lesson.js";
import type { ChainClient } from "../../src/ports/chain-client.js";
import { fixedClock } from "../../src/ports/clock.js";
import { makeCtx, memLessonRepo } from "./tool-context.js";

// YAP-SOL, closed 2026-09-27 — the figures Meteora's "All Closed Position" view showed:
// deposit $36.30, withdrawn $35.08, fees claimed $4.56 → PnL +$3.34 (+9.19%).
const YAP: ClosedPositionPnl = {
  position: "DYU4yapPosition",
  deposits_usd: 36.3,
  withdrawals_usd: 35.08,
  fees_usd: 4.56,
};

describe("settledClosePnl", () => {
  it("reproduces Meteora's closed-position PnL", () => {
    const pnl = settledClosePnl(YAP)!;
    expect(pnl.pnl_usd).toBe(-1.22); // price only
    expect(pnl.fees_earned_usd).toBe(4.56);
    expect(pnl.pnl_usd + pnl.fees_earned_usd).toBeCloseTo(3.34, 2); // net, as Meteora shows it
    expect(pnl.pnl_pct).toBeCloseTo(9.2, 1);
    expect(pnl.initial_value_usd).toBe(36.3);
    expect(pnl.final_value_usd).toBe(35.08);
  });

  it("rejects totals whose withdrawal has not been indexed yet", () => {
    expect(settledClosePnl({ ...YAP, withdrawals_usd: 0 })).toBeNull();
    expect(settledClosePnl({ ...YAP, deposits_usd: 0 })).toBeNull();
  });
});

describe("estimateClosePnl", () => {
  it("keeps pnl_pct consistent with the USD figures (net of fees)", () => {
    const est = estimateClosePnl({ initialValueUsd: 36.3, finalValueUsd: 35.35, feesUsd: 4.56, fallbackPnlPct: 99 });
    expect(est.pnl_usd).toBe(-0.95);
    expect(est.pnl_pct).toBeCloseTo(((35.35 + 4.56 - 36.3) / 36.3) * 100, 6);
  });

  it("falls back to the reported % and backs out price-only PnL when exit value is missing", () => {
    const est = estimateClosePnl({ initialValueUsd: 100, finalValueUsd: null, feesUsd: 2, fallbackPnlPct: 5 });
    expect(est.pnl_pct).toBe(5);
    expect(est.pnl_usd).toBe(3); // net 5 minus 2 of fees
  });
});

describe("enrichCloseResult", () => {
  const raw: CloseResult = {
    success: true,
    position_address: "P",
    pool_address: "Pool",
    base_mint: null,
    final_pnl_pct: null,
    final_value_usd: null,
    fees_earned_usd: 0,
    reason: "take profit",
    tx: "sig",
    dry_run: false,
  };
  const snap: OnChainPosition = {
    position: "P",
    pool: "Pool",
    pair: "YAP/SOL",
    base_mint: "Yap",
    lower_bin: -419,
    upper_bin: -350,
    active_bin: -380,
    in_range: true,
    unclaimed_fees_usd: 0.37,
    claimed_fees_usd: 4.19,
    pnl_pct: 9.94,
    pnl_pct_suspicious: false,
    total_value_usd: 35.35,
    deposit_usd: 36.3,
  };

  it("counts fees already claimed, not just the unclaimed remainder", () => {
    expect(enrichCloseResult(raw, snap).fees_earned_usd).toBeCloseTo(4.56, 6);
  });

  it("carries Meteora's deposit as the entry value", () => {
    expect(enrichCloseResult(raw, snap).initial_value_usd).toBe(36.3);
  });
});

function perf(position: string, recordedAt: string, over: Partial<PerformanceRecord> = {}): PerformanceRecord {
  return {
    position,
    pool: "Pool",
    pnl_pct: 9.94,
    pnl_usd: -0.95,
    fees_earned_usd: 0.37,
    initial_value_usd: 36.3,
    final_value_usd: 35.35,
    close_reason: "take profit",
    recorded_at: recordedAt,
    closed_at: recordedAt,
    ...over,
  };
}

function chainWith(lookup: ChainClient["getClosedPositionPnl"]): ChainClient {
  const base = createDryRunChainClient({ clock: fixedClock("2026-09-27T12:00:00.000Z") });
  return { ...base, getClosedPositionPnl: lookup };
}

describe("finalizeClosedPerformance", () => {
  const clock = fixedClock("2026-09-27T12:00:00.000Z");

  it("overwrites the close-time estimate with Meteora's settled totals", async () => {
    const lessons = memLessonRepo();
    await lessons.appendPerformance(perf(YAP.position, "2026-09-27T11:26:00.000Z"));
    const lookup = vi.fn(async () => YAP);
    const ctx = makeCtx({ clock, chain: chainWith(lookup), repos: { lessons } });

    expect(await finalizeClosedPerformance(ctx)).toBe(1);
    const [rec] = await lessons.recentPerformance();
    expect(rec).toMatchObject({
      pnl_usd: -1.22,
      fees_earned_usd: 4.56,
      initial_value_usd: 36.3,
      final_value_usd: 35.08,
      pnl_source: "meteora_closed",
    });
    expect(lookup).toHaveBeenCalledWith("Pool", YAP.position);

    // Settled records are never looked up again.
    lookup.mockClear();
    expect(await finalizeClosedPerformance(ctx)).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("leaves the estimate in place when the close is not indexed yet", async () => {
    const lessons = memLessonRepo();
    await lessons.appendPerformance(perf("P1", "2026-09-27T11:59:00.000Z"));
    const ctx = makeCtx({ clock, chain: chainWith(async () => null), repos: { lessons } });

    expect(await finalizeClosedPerformance(ctx)).toBe(0);
    const [rec] = await lessons.recentPerformance();
    expect(rec?.pnl_source).toBeUndefined();
    expect(rec?.pnl_usd).toBe(-0.95);
  });

  it("survives a throwing lookup and still settles the rest", async () => {
    const lessons = memLessonRepo();
    await lessons.appendPerformance(perf("OLD", "2026-09-26T10:00:00.000Z"));
    await lessons.appendPerformance(perf("NEW", "2026-09-27T11:00:00.000Z"));
    const lookup = vi.fn(async (_pool: string, position: string) => {
      if (position === "NEW") throw new Error("datapi 502");
      return { ...YAP, position };
    });
    const ctx = makeCtx({ clock, chain: chainWith(lookup), repos: { lessons } });

    expect(await finalizeClosedPerformance(ctx)).toBe(1);
    const recs = await lessons.recentPerformance();
    expect(recs.find((r) => r.position === "OLD")?.pnl_source).toBe("meteora_closed");
    expect(recs.find((r) => r.position === "NEW")?.pnl_source).toBeUndefined();
  });

  it("skips records outside the lookback window and bounds work per tick, newest first", async () => {
    const lessons = memLessonRepo();
    await lessons.appendPerformance(perf("ANCIENT", "2026-08-01T00:00:00.000Z"));
    for (let i = 0; i < FINALIZE_MAX_PER_TICK + 3; i++) {
      await lessons.appendPerformance(perf(`R${i}`, `2026-09-27T0${Math.min(i, 9)}:${String(i).padStart(2, "0")}:00.000Z`));
    }
    const seen: string[] = [];
    const ctx = makeCtx({
      clock,
      chain: chainWith(async (_pool, position) => {
        seen.push(position);
        return null;
      }),
      repos: { lessons },
    });

    await finalizeClosedPerformance(ctx);
    expect(seen).toHaveLength(FINALIZE_MAX_PER_TICK);
    expect(seen[0]).toBe(`R${FINALIZE_MAX_PER_TICK + 2}`);
    expect(seen).not.toContain("ANCIENT");
  });

  it("is a no-op on a chain without a closed-PnL source", async () => {
    const lessons = memLessonRepo();
    await lessons.appendPerformance(perf("P1", "2026-09-27T11:00:00.000Z"));
    const ctx = makeCtx({ clock, repos: { lessons } }); // dry-run chain: no getClosedPositionPnl
    expect(await finalizeClosedPerformance(ctx)).toBe(0);
  });
});
