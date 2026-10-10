import { describe, expect, it } from "vitest";
import { learningModelFor } from "../../src/domain/rules/learning-model.js";
import { readFileSync } from "node:fs";
import { parseAppConfig } from "../../src/domain/config-load.js";

const llm = (over: Partial<Parameters<typeof learningModelFor>[0]> = {}) => ({
  managementModel: "mgmt",
  learningModel: "",
  learningImportantModel: "",
  learningImportantLossPct: -10,
  ...over,
});

describe("learningModelFor", () => {
  it("falls back to managementModel when nothing is set (no behaviour change)", () => {
    expect(learningModelFor(llm(), -30)).toEqual({ model: "mgmt", tier: "important" });
    expect(learningModelFor(llm(), 5)).toEqual({ model: "mgmt", tier: "normal" });
  });

  it("uses the expensive model only for losses at or below the threshold", () => {
    const cfg = llm({ learningModel: "cheap", learningImportantModel: "pricey" });
    expect(learningModelFor(cfg, -10).model).toBe("pricey");
    expect(learningModelFor(cfg, -42).model).toBe("pricey");
    expect(learningModelFor(cfg, -9.9).model).toBe("cheap");
    expect(learningModelFor(cfg, 7).model).toBe("cheap");
  });

  it("important without its own model uses learningModel", () => {
    expect(learningModelFor(llm({ learningModel: "cheap" }), -20).model).toBe("cheap");
  });
});

describe("config", () => {
  it("defaults the learning keys for a config that predates them", () => {
    const legacy = JSON.parse(readFileSync("user-config.example.json", "utf8")) as Record<string, unknown>;
    expect(Object.keys(legacy).some((k) => k.startsWith("learning"))).toBe(false);
    const r = parseAppConfig(legacy);
    if (!r.ok) throw new Error(JSON.stringify(r.error).slice(0, 300));
    expect(r.value.llm).toMatchObject({ learningModel: "", learningImportantModel: "", learningImportantLossPct: -10 });
  });
});
