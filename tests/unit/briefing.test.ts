import { describe, it, expect } from "vitest";
import { generateBriefing } from "../../src/app/briefing/generate.ts";
import type { TrackedPosition } from "../../src/domain/schemas/position.ts";
import type { Lesson, PerformanceRecord } from "../../src/domain/schemas/lesson.ts";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const HOUR = 3_600_000;

function trackedFixture(overrides: Partial<TrackedPosition> = {}): TrackedPosition {
  return {
    position: "PosA",
    pool: "PoolA",
    pool_name: "MEME/SOL",
    strategy: "bid_ask",
    bin_range: { min: -20, max: 20 },
    amount_sol: 0.5,
    active_bin_at_deploy: 0,
    deployed_at: "2026-07-05T10:00:00.000Z", // 2h ago
    ...overrides,
  };
}

function perfFixture(overrides: Partial<PerformanceRecord>): PerformanceRecord {
  return {
    position: "PosA",
    pool: "PoolA",
    pnl_pct: 5,
    pnl_usd: 20,
    fees_earned_usd: 2,
    close_reason: "TAKE_PROFIT",
    recorded_at: "2026-07-05T09:00:00.000Z",
    ...overrides,
  };
}

function lessonFixture(overrides: Partial<Lesson>): Lesson {
  return {
    id: "L1",
    rule: "Prefer high fee/TVL pools",
    tags: [],
    pinned: false,
    ...overrides,
  };
}

describe("generateBriefing", () => {
  it("counts positions opened and closed in the 24h window", () => {
    const positions: TrackedPosition[] = [
      trackedFixture({ position: "P1", deployed_at: "2026-07-05T11:00:00.000Z" }), // 1h ago → opened
      trackedFixture({
        position: "P2",
        deployed_at: "2026-07-04T09:00:00.000Z", // 27h ago → outside opened window
        closed: true,
        closed_at: "2026-07-05T02:00:00.000Z", // 10h ago → closed in window
      }),
      trackedFixture({
        position: "P3",
        deployed_at: "2026-07-03T10:00:00.000Z", // 2 days ago
        closed: true,
        closed_at: "2026-07-03T22:00:00.000Z", // outside window
      }),
    ];
    const summary = generateBriefing({
      positions,
      performance: [],
      lessons: [],
      now: NOW,
    });
    expect(summary.counts.opened_24h).toBe(1);
    expect(summary.counts.closed_24h).toBe(1);
    expect(summary.counts.open_positions).toBe(1); // P1 still open
  });

  it("aggregates net pnl + fees + win rate over the window", () => {
    const summary = generateBriefing({
      positions: [],
      performance: [
        perfFixture({ pnl_usd: 30, fees_earned_usd: 3, recorded_at: NOW.toISOString() }),
        perfFixture({ pnl_usd: -10, fees_earned_usd: 1, recorded_at: NOW.toISOString() }),
        perfFixture({ pnl_usd: 15, fees_earned_usd: 2, recorded_at: NOW.toISOString() }),
        perfFixture({
          pnl_usd: 999,
          fees_earned_usd: 99,
          recorded_at: new Date(NOW.getTime() - 48 * HOUR).toISOString(), // outside
        }),
      ],
      lessons: [],
      now: NOW,
    });
    expect(summary.counts.net_pnl_usd_24h).toBe(41); // (30+3) + (-10+1) + (15+2): fees included
    expect(summary.counts.fees_usd_24h).toBe(6);
    expect(summary.counts.win_rate_pct_24h).toBe(67); // 2 of 3
  });

  it("renders `N/A` win rate when no performance records exist in the window", () => {
    const summary = generateBriefing({ positions: [], performance: [], lessons: [], now: NOW });
    expect(summary.counts.win_rate_pct_24h).toBeNull();
    expect(summary.plain).toContain("Win rate: N/A");
    expect(summary.html).toContain("Win rate: N/A");
  });

  it("lists new lessons in the window (up to 5)", () => {
    const lessons = Array.from({ length: 8 }, (_, i) =>
      lessonFixture({ id: `L${i}`, rule: `rule ${i}`, created_at: NOW.toISOString() }),
    );
    const summary = generateBriefing({ positions: [], performance: [], lessons, now: NOW });
    expect(summary.counts.new_lessons_24h).toBe(8);
    // Only 5 in the rendered body.
    const lineHits = summary.plain.split("\n").filter((l) => l.startsWith("• rule"));
    expect(lineHits).toHaveLength(5);
  });

  it("emits HTML with <b> tags for section headers", () => {
    const summary = generateBriefing({ positions: [], performance: [], lessons: [], now: NOW });
    expect(summary.html).toContain("<b>Activity:</b>");
    expect(summary.html).toContain("<b>Performance:</b>");
    expect(summary.html).toContain("<b>Lessons:</b>");
    expect(summary.html).toContain("<b>Current portfolio:</b>");
  });

  it("respects the lookbackHours override", () => {
    const positions = [
      trackedFixture({
        position: "P1",
        deployed_at: new Date(NOW.getTime() - 3 * HOUR).toISOString(), // 3h ago
      }),
    ];
    const summary6h = generateBriefing({
      positions,
      performance: [],
      lessons: [],
      now: NOW,
      lookbackHours: 6,
    });
    expect(summary6h.counts.opened_24h).toBe(1);
    const summary1h = generateBriefing({
      positions,
      performance: [],
      lessons: [],
      now: NOW,
      lookbackHours: 1,
    });
    expect(summary1h.counts.opened_24h).toBe(0);
  });

  it("prefixes a positive net PnL with +, negative uses the number's own sign", () => {
    const positive = generateBriefing({
      positions: [],
      performance: [perfFixture({ pnl_usd: 12, recorded_at: NOW.toISOString() })],
      lessons: [],
      now: NOW,
    });
    expect(positive.plain).toContain("+$14.00"); // 12 + 2 fees
    const negative = generateBriefing({
      positions: [],
      performance: [perfFixture({ pnl_usd: -8, recorded_at: NOW.toISOString() })],
      lessons: [],
      now: NOW,
    });
    expect(negative.plain).toContain("$-6.00"); // -8 + 2 fees
  });
});
