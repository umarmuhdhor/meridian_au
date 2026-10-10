import { describe, it, expect } from "vitest";
import { mergeToolCallFragments } from "../../src/adapters/llm/openrouter.js";

describe("mergeToolCallFragments", () => {
  it("re-joins a call a proxy split into delta fragments", () => {
    const merged = mergeToolCallFragments([
      { id: "call_1", name: "deploy_position", arguments: "" },
      { id: "", name: "", arguments: '{"amount_sol":' },
      { id: "", name: "", arguments: "0.1" },
      { id: "", name: "", arguments: ',"pool":"ABC"}' },
    ]);
    expect(merged).toEqual([
      { id: "call_1", name: "deploy_position", arguments: '{"amount_sol":0.1,"pool":"ABC"}' },
    ]);
  });

  it("leaves well-formed parallel calls untouched", () => {
    const calls = [
      { id: "a", name: "get_token_info", arguments: '{"mint":"X"}' },
      { id: "b", name: "get_pool_memory", arguments: '{"pool_address":"P"}' },
    ];
    expect(mergeToolCallFragments(calls)).toEqual(calls);
  });

  it("drops a leading orphan fragment with no name", () => {
    expect(mergeToolCallFragments([{ id: "", name: "", arguments: "{" }])).toEqual([]);
  });
});
