import { describe, it, expect } from "vitest";
import {
  getExitDecision,
  getPollerFastCut,
  PNL_WARMUP_MINUTES,
  type ExitSignals,
} from "../../src/domain/rules/close-rules.js";
import type { ManagementConfig } from "../../src/domain/schemas/config.js";
import type { TechnicalsSummary } from "../../src/domain/schemas/kline.js";
import { mgmt } from "./fixtures.js";

// Realistic thresholds: attention stop (-15) SHALLOWER than the catastrophic
// floor (-25), so a -18% loss lands in "concern" territory, not catastrophic.
const cfg: ManagementConfig = {
  ...mgmt,
  stopLossPct: -15,
  exitHardFloorPct: -25,
  exitOorProxyPct: -12,
  dyingConsecutiveRed: 4,
  dyingAtrCollapsePct: 10,
  healthyFeeVelocityMin: 12,
  minFeePerTvl24h: 6,
};

function tech(tf: "15m" | "1h", over: Partial<TechnicalsSummary> = {}): TechnicalsSummary {
  return {
    timeframe: tf,
    candles: 100,
    last_close: 1,
    spike_pct: null,
    at_local_top: null,
    at_local_bottom: null,
    atr_pct: null,
    vol_spike: null,
    trend: null,
    from_window_high_pct: null,
    nearest_support: 0.9,
    support_distance_pct: null,
    support_touches: null,
    consecutive_red_count: 0,
    ...over,
  };
}

const inRangeBase: ExitSignals = {
  pnl_pct: -18,
  in_range: true,
  active_bin: 5,
  lower_bin: 0,
  upper_bin: 10,
  fee_per_tvl_24h: 3,
};

describe("getExitDecision — regime classifier", () => {
  it("CATASTROPHIC: pnl at/below the hard floor closes unconditionally", () => {
    const d = getExitDecision({ ...inRangeBase, pnl_pct: -30, fee_per_tvl_24h: 50 }, cfg);
    expect(d.action).toBe("CLOSE");
    expect(d.regime).toBe("CATASTROPHIC");
  });

  it("DYING: OOR-below + support broken closes early, ABOVE the stop level", () => {
    const d = getExitDecision(
      {
        pnl_pct: -8, // above stop -15, but structurally dead
        in_range: false,
        active_bin: -500,
        lower_bin: -449,
        upper_bin: -380,
        fee_per_tvl_24h: 1,
        technicals: [tech("1h", { nearest_support: null })],
      },
      cfg,
    );
    expect(d.action).toBe("CLOSE");
    expect(d.regime).toBe("DYING");
  });

  it("DYING: N red candles + dead fee velocity closes", () => {
    const d = getExitDecision(
      { ...inRangeBase, pnl_pct: -6, fee_per_tvl_24h: 1, technicals: [tech("1h", { consecutive_red_count: 5 })] },
      cfg,
    );
    expect(d.action).toBe("CLOSE");
    expect(d.regime).toBe("DYING");
  });

  it("HEALTHY: in-range + strong fees holds PAST the stop", () => {
    const d = getExitDecision(
      { ...inRangeBase, pnl_pct: -18, fee_per_tvl_24h: 20, technicals: [tech("1h", { trend: "UP" })] },
      cfg,
    );
    expect(d.action).toBe("HOLD");
    expect(d.regime).toBe("HEALTHY");
  });

  it("OK: not yet in loss-concern territory holds without escalation", () => {
    const d = getExitDecision({ ...inRangeBase, pnl_pct: -5, fee_per_tvl_24h: 3 }, cfg);
    expect(d.action).toBe("HOLD");
    expect(d.regime).toBe("OK");
  });

  it("AMBIGUOUS: in-range, weak fees, below stop → escalate", () => {
    const d = getExitDecision({ ...inRangeBase, pnl_pct: -18, fee_per_tvl_24h: 3 }, cfg);
    expect(d.action).toBe("ESCALATE");
    expect(d.regime).toBe("AMBIGUOUS");
  });

  it("suspect pnl defers (never stops out on an unpriceable tick)", () => {
    const d = getExitDecision({ ...inRangeBase, pnl_pct: -80, pnl_pct_suspicious: true }, cfg);
    expect(d.action).toBe("HOLD");
    expect(d.regime).toBe("AMBIGUOUS");
  });

  it("HEALTHY is NOT granted when both timeframes trend DOWN", () => {
    const d = getExitDecision(
      {
        ...inRangeBase,
        pnl_pct: -18,
        fee_per_tvl_24h: 20,
        technicals: [tech("15m", { trend: "DOWN" }), tech("1h", { trend: "DOWN" })],
      },
      cfg,
    );
    expect(d.regime).toBe("AMBIGUOUS");
  });
});

describe("getPollerFastCut — on-chain fast-cut", () => {
  it("fires on the catastrophic floor", () => {
    expect(getPollerFastCut({ pnl_pct: -30, active_bin: 5, lower_bin: 0 }, cfg)).toMatch(/catastrophic/);
  });

  it("fires on OOR-below past the proxy threshold", () => {
    expect(getPollerFastCut({ pnl_pct: -13, active_bin: -500, lower_bin: -449 }, cfg)).toMatch(/OOR-below/);
  });

  it("does NOT fire in-range at the same pnl", () => {
    expect(getPollerFastCut({ pnl_pct: -13, active_bin: 5, lower_bin: 0 }, cfg)).toBeNull();
  });

  it("does NOT fire OOR-below above the proxy threshold", () => {
    expect(getPollerFastCut({ pnl_pct: -5, active_bin: -500, lower_bin: -449 }, cfg)).toBeNull();
  });

  it("does NOT fire on a suspect tick", () => {
    expect(
      getPollerFastCut({ pnl_pct: -80, pnl_pct_suspicious: true, active_bin: -500, lower_bin: -449 }, cfg),
    ).toBeNull();
  });
});

// Meteora datapi lags a fresh deposit and reads pnl −100% for the first seconds.
// OTC-SOL / FLAME-SOL were fast-cut 3–5 s after deploy on exactly that reading.
describe("pnl warm-up window (fresh positions)", () => {
  it("fast-cut does NOT fire on a −100% reading inside the warm-up window", () => {
    expect(getPollerFastCut({ pnl_pct: -100, active_bin: 5, lower_bin: 0, age_minutes: 0 }, cfg)).toBeNull();
    expect(
      getPollerFastCut({ pnl_pct: -30, active_bin: -500, lower_bin: -449, age_minutes: PNL_WARMUP_MINUTES - 1 }, cfg),
    ).toBeNull();
  });

  it("fast-cut fires again once the window has passed", () => {
    expect(
      getPollerFastCut({ pnl_pct: -30, active_bin: 5, lower_bin: 0, age_minutes: PNL_WARMUP_MINUTES }, cfg),
    ).toMatch(/catastrophic/);
  });

  it("unknown age is never treated as warm-up (exits are not suppressed on missing data)", () => {
    expect(getPollerFastCut({ pnl_pct: -30, active_bin: 5, lower_bin: 0, age_minutes: null }, cfg)).toMatch(
      /catastrophic/,
    );
    expect(getExitDecision({ ...inRangeBase, pnl_pct: -30, age_minutes: null }, cfg).regime).toBe("CATASTROPHIC");
  });

  it("regime engine holds a fresh position instead of classifying it CATASTROPHIC", () => {
    const d = getExitDecision({ ...inRangeBase, pnl_pct: -100, age_minutes: 1 }, cfg);
    expect(d.action).toBe("HOLD");
    expect(d.reason).toMatch(/warm-up/);
  });
});
