import { describe, it, expect } from "vitest";
import { plainCondition, plainLesson, techChips, fmtMcap } from "./lesson-plain";

describe("lesson-plain", () => {
  it("translates numeric conditions with a direction-aware gist", () => {
    expect(plainCondition("1h.vol_x < 0.1")).toEqual({
      gist: "Volume sepi (1 jam)",
      detail: "volume 1 jam vs normal di bawah 0.1×",
      raw: "1h.vol_x < 0.1",
      concept: { key: "vol_x:low", label: "Volume sepi", tf: "1 jam" },
    });
    expect(plainCondition("15m.from_high > -10").gist).toBe("Masih dekat puncak (15 menit)");
    expect(plainCondition("1h.from_high < -30").gist).toBe("Sudah jatuh jauh dari puncak (1 jam)");
    expect(plainCondition("15m.spike < 0").gist).toBe("Harga sedang koreksi (15 menit)");
    expect(plainCondition("1h.spike > 100").gist).toBe("Harga baru melonjak tajam (1 jam)");
    expect(plainCondition("mcap < 1000000").detail).toBe("market cap di bawah $1 jt");
    expect(plainCondition("15m.red_streak >= 3").detail).toBe("candle merah beruntun 15 menit minimal 3");
    expect(plainCondition("15m.from_high > -10").detail).toBe("sudah turun kurang dari 10% dari puncak 15 menit");
    expect(plainCondition("1h.from_high < -30").detail).toBe("sudah turun lebih dari 30% dari puncak 1 jam");
    expect(plainCondition("1h.support_dist > -5").detail).toBe("support 1 jam kurang dari 5% di bawah harga");
    expect(plainCondition("15m.spike < 0").detail).toBe("harga 15 menit tidak naik");
  });

  it("translates trend, local top and strategy", () => {
    expect(plainCondition("1h.trend = UP").gist).toBe("Tren 1 jam NAIK");
    expect(plainCondition("15m.trend=DOWN").gist).toBe("Tren 15 menit TURUN");
    expect(plainCondition("1h.at_local_top = NO").gist).toBe("Harga 1 jam tidak di pucuk lokal");
    expect(plainCondition("strategy = spot").gist).toBe("Strategi spot");
  });

  it("groups conditions into timeframe-free concepts", () => {
    expect(plainCondition("15m.from_high > -10").concept).toEqual({ key: "from_high:high", label: "Masih dekat puncak", tf: "15 menit" });
    expect(plainCondition("1h.from_high > -5").concept.key).toBe("from_high:high");
    expect(plainCondition("15m.spike < -5").concept.label).toBe("Harga tidak sedang melonjak");
    expect(plainCondition("15m.spike < 2").concept.key).toBe(plainCondition("1h.spike < 0").concept.key);
    expect(plainCondition("1h.trend=UP").concept).toEqual({ key: "trend=UP", label: "Tren NAIK", tf: "1 jam" });
    expect(plainCondition("bin_step=200").concept.key).toBe("bin_step:=200");
  });

  it("strips follow-lesson prefixes too", () => {
    expect(plainLesson("[follow:a] PREFER bin_step=200 AND 1h.spike > 120 — pumps", "bin_step=200 AND 1h.spike > 120").action).toBe("ULANGI");
  });

  it("falls back to the raw text for unknown fields", () => {
    expect(plainCondition("weird.thing > 3").gist).toBe("weird.thing > 3");
  });

  it("parses an auto lesson into action, conditions and explanation", () => {
    const rule =
      "[auto LOSS RARI-SOL -19.4%] AVOID spot when 15m.from_high > -10 AND fee_tvl_ratio < 0.3 — dead-cat with no fee cover. {applies ONLY when: 15m.from_high > -10 AND fee_tvl_ratio < 0.3 — history 0W/1L}";
    const p = plainLesson(rule, "15m.from_high > -10 AND fee_tvl_ratio < 0.3");
    expect(p.action).toBe("HINDARI");
    expect(p.strategy).toBe("spot");
    expect(p.conditions.map((c) => c.gist)).toEqual(["Masih dekat puncak (15 menit)", "Fee pool kecil"]);
    expect(p.explanation).toBe("dead-cat with no fee cover.");
  });

  it("leaves free-text lessons as text", () => {
    const p = plainLesson("EXTREME VOL VETO: NO DEPLOY when 1h ATR > 25%");
    expect(p.action).toBeNull();
    expect(p.conditions).toEqual([]);
    expect(p.text).toBe("EXTREME VOL VETO: NO DEPLOY when 1h ATR > 25%");
  });

  it("renders technicals as toned chips", () => {
    const chips = techChips({ timeframe: "1h", trend: "DOWN", from_window_high_pct: -31.1, vol_spike: 0.4 });
    expect(chips).toEqual([
      { text: "Tren TURUN", tone: "loss" },
      { text: "31% di bawah puncak", tone: "loss" },
      { text: "Volume sepi (0.4×)", tone: "loss" },
    ]);
  });

  it("formats market cap compactly", () => {
    expect(fmtMcap(7_000_000)).toBe("$7 jt");
    expect(fmtMcap(2_500)).toBe("$2.5 rb");
  });
});
