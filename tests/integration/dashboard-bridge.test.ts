import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startBridge, type BridgeHandle } from "../../src/adapters/dashboard/server.js";
import { createRegistry } from "../../src/app/tools/registry.js";
import { getWalletBalanceTool } from "../../src/app/tools/impls/get-wallet-balance.js";
import { getMyPositionsTool } from "../../src/app/tools/impls/get-my-positions.js";
import { closePositionTool } from "../../src/app/tools/impls/close-position.js";
import { addLessonTool } from "../../src/app/tools/impls/add-lesson.js";
import { createFakeLLM } from "../../src/adapters/llm/fake.js";
import { makeCtx } from "../unit/tool-context.js";
import { mkTmpDir, rmDir } from "./tmpdir.js";

const PORT = 8791;
const TOKEN = "test-bridge-token";
const BASE = `http://127.0.0.1:${PORT}`;

const get = (p: string, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${p}`, { headers });
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const auth = { Authorization: `Bearer ${TOKEN}` };

describe("dashboard bridge", () => {
  let handle: BridgeHandle | null = null;
  let stateDir: string;
  let ctx: ReturnType<typeof makeCtx>;

  beforeAll(async () => {
    stateDir = await mkTmpDir("bridge");
    await writeFile(
      path.join(stateDir, "decision-log.json"),
      JSON.stringify({ decisions: [] }),
      "utf8",
    );
    await writeFile(
      path.join(stateDir, "lessons.json"),
      JSON.stringify({ lessons: [{ id: "l1", rule: "x" }], performance: [] }),
      "utf8",
    );
    ctx = makeCtx();
    const registry = createRegistry([getWalletBalanceTool, getMyPositionsTool, closePositionTool, addLessonTool]);
    const llm = createFakeLLM({ script: [], model: "demo/fake-v1" });
    handle = startBridge({
      port: PORT,
      token: TOKEN,
      ctx,
      llm,
      registry,
      model: "demo/fake-v1",
      stateDir,
    });
    // give listen() a tick
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    if (handle) await handle.close();
    await rmDir(stateDir);
  });

  it("refuses to start without a token", () => {
    const ctx = makeCtx();
    const h = startBridge({
      token: undefined,
      ctx,
      llm: createFakeLLM({ script: [], model: "x" }),
      registry: createRegistry([]),
      model: "x",
      stateDir,
    });
    expect(h).toBeNull();
  });

  it("401s without a valid bearer token", async () => {
    const r = await get("/health");
    expect(r.status).toBe(401);
  });

  it("GET /health returns uptime_sec snake_case", async () => {
    const r = await get("/health", auth);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.uptime_sec).toBe("number");
    expect(body.daemon).toBe("running");
  });

  it("GET /state/positions returns a positions snapshot", async () => {
    const r = await get("/state/positions", auth);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(Array.isArray(body.positions)).toBe(true);
    expect(typeof body.total_positions).toBe("number");
  });

  it("GET /state/summary returns { summary, balance } with snake_case balance", async () => {
    const r = await get("/state/summary", auth);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { summary: unknown; balance: Record<string, unknown> };
    expect(body).toHaveProperty("summary");
    expect(body).toHaveProperty("balance");
    expect(typeof body.balance.sol).toBe("number");
    expect(typeof body.balance.total_usd).toBe("number");
    expect(Array.isArray(body.balance.tokens)).toBe(true);
  });

  it("GET /state/community-lessons returns each backup lesson with its verdict", async () => {
    await ctx.repos.lessons.addLesson({
      id: "c-test",
      rule: "community caution",
      tags: ["community"],
      pinned: false,
      sourceType: "community",
      outcome: "loss",
      match: "tvl < 20000 AND mcap < 1000000",
      context: { evidence: "n=113" },
    });
    const r = await get("/state/community-lessons", auth);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { trades: number; lessons: Array<Record<string, unknown>> };
    expect(body.trades).toBe(0);
    expect(body.lessons).toEqual([
      expect.objectContaining({ id: "c-test", status: "untested", evidence: "n=113", match: "tvl < 20000 AND mcap < 1000000" }),
    ]);
  });

  it("GET /state/file/lessons returns the whitelisted file", async () => {
    const r = await get("/state/file/lessons", auth);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { lessons: unknown[] };
    expect(Array.isArray(body.lessons)).toBe(true);
  });

  it("GET /state/file/:name rejects non-whitelisted names", async () => {
    const r = await get("/state/file/etc-passwd", auth);
    expect(r.status).toBe(400);
  });

  it("POST /tool runs an allowed read tool → { ok, result }", async () => {
    const r = await post("/tool", { name: "get_wallet_balance", args: {} }, auth);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; result: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(typeof body.result.sol).toBe("number");
  });

  it("POST /tool adapts get_wallet_balance to the web shape (total_usd + tokens)", async () => {
    const r = await post("/tool", { name: "get_wallet_balance", args: {} }, auth);
    const body = (await r.json()) as { result: Record<string, unknown> };
    expect(typeof body.result.total_usd).toBe("number");
    expect(Array.isArray(body.result.tokens)).toBe(true);
  });

  it("POST /tool runs an allowlisted write tool with confirm (add_lesson)", async () => {
    const r = await post("/tool", { name: "add_lesson", args: { rule: "AVOID rugs" }, confirm: true }, auth);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; result: { id: string } };
    expect(body.ok).toBe(true);
    expect(typeof body.result.id).toBe("string");
  });

  it("POST /tool rejects a duplicate cycle_id after a committed write", async () => {
    const cycleId = "test-cycle-" + PORT;
    // first write with a cycle_id succeeds and commits the key
    const r1 = await post(
      "/tool",
      { name: "add_lesson", args: { rule: "cycle guard" }, confirm: true, cycle_id: cycleId },
      auth,
    );
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { ok: boolean }).ok).toBe(true);
    // second write reusing the same cycle_id is rejected before executing
    const r2 = await post(
      "/tool",
      { name: "add_lesson", args: { rule: "cycle guard again" }, confirm: true, cycle_id: cycleId },
      auth,
    );
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as { error: string }).error).toMatch(/duplicate/);
  });

  it("POST /tool denies tools outside the allowlist (self_update)", async () => {
    const r = await post("/tool", { name: "self_update", args: {} }, auth);
    expect(r.status).toBe(403);
  });

  it("POST /tool blocks update_config when a cycle_id is attached (human-gated)", async () => {
    const r = await post(
      "/tool",
      {
        name: "update_config",
        args: { changes: { stopLossPct: -10 }, reason: "test" },
        confirm: true,
        cycle_id: "screen-2026-08-02-abc",
      },
      auth,
    );
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/human-gated/);
  });

  it("POST /tool requires confirm for write tools", async () => {
    const r = await post("/tool", { name: "close_position", args: { position_address: "x" } }, auth);
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/confirm/);
  });

  it("returns 404 for unknown routes", async () => {
    const r = await get("/nope", auth);
    expect(r.status).toBe(404);
  });
});
