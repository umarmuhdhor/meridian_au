import { describe, it, expect, vi } from "vitest";
import {
  RECONCILED_CLOSE_NOTE,
  recordReconciledCloses,
} from "../../src/app/management/finalize-performance.js";
import { sendRecoveringExpiry } from "../../src/adapters/chain/meteora/send-tx.js";
import type { TrackedPosition } from "../../src/domain/schemas/position.js";
import type { PositionRepo } from "../../src/ports/position-repo.js";
import { makeCtx, memLessonRepo } from "./tool-context.js";

function positionRepo(rows: TrackedPosition[]): PositionRepo {
  return {
    async load() {
      return { ok: true, value: { positions: {}, recentEvents: [], lastUpdated: null } };
    },
    async save() {},
    async pushEvent() {},
    async get(a) {
      return rows.find((r) => r.position === a) ?? null;
    },
    async all() {
      return rows;
    },
    async upsert() {},
  };
}

function tracked(over: Partial<TrackedPosition>): TrackedPosition {
  return {
    position: "posA",
    pool: "poolA",
    pool_name: "Altai-SOL",
    strategy: "spot",
    amount_sol: 0.3,
    deployed_at: "2026-07-05T04:00:00.000Z",
    closed: true,
    closed_at: "2026-07-05T11:00:00.000Z",
    notes: [RECONCILED_CLOSE_NOTE],
    ...over,
  } as TrackedPosition;
}

describe("recordReconciledCloses", () => {
  it("adds an estimate record for a reconciled close with no History row, once", async () => {
    const lessons = memLessonRepo();
    const ctx = makeCtx({
      repos: {
        lessons,
        positions: positionRepo([
          tracked({}),
          tracked({ position: "posOpen", closed: false, notes: [] }),
          tracked({ position: "posToolClosed", notes: [] }),
        ]),
      },
    });

    expect(await recordReconciledCloses(ctx)).toBe(1);
    expect(await recordReconciledCloses(ctx)).toBe(0);

    const perf = (await lessons.recentPerformance(10)).filter((p) => p.position === "posA");
    expect(perf).toHaveLength(1);
    expect(perf[0]).toMatchObject({
      pool: "poolA",
      pool_name: "Altai-SOL",
      pnl_source: "estimate",
      strategy: "spot",
      minutes_held: 420,
      closed_at: "2026-07-05T11:00:00.000Z",
    });
  });

  it("skips reconciled closes older than the lookback window", async () => {
    const ctx = makeCtx({
      repos: { positions: positionRepo([tracked({ closed_at: "2026-06-01T00:00:00.000Z" })]) },
    });
    expect(await recordReconciledCloses(ctx)).toBe(0);
  });
});

function expiredError(signature: string): Error {
  return Object.assign(new Error(`Signature ${signature} has expired: block height exceeded.`), { signature });
}

describe("sendRecoveringExpiry", () => {
  const noSleep = async () => {};

  it("treats an expired-but-landed tx as success", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ err: null, confirmationStatus: "confirmed" });
    const sig = await sendRecoveringExpiry(() => Promise.reject(expiredError("SIG1")), getStatus, {
      sleep: noSleep,
    });
    expect(sig).toBe("SIG1");
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("rethrows when the expired tx never shows up", async () => {
    await expect(
      sendRecoveringExpiry(() => Promise.reject(expiredError("SIG2")), async () => null, {
        attempts: 3,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("rethrows when the tx landed with an error", async () => {
    await expect(
      sendRecoveringExpiry(
        () => Promise.reject(expiredError("SIG3")),
        async () => ({ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }),
        { sleep: noSleep },
      ),
    ).rejects.toThrow(/expired/);
  });

  it("does not touch non-expiry errors", async () => {
    const getStatus = vi.fn();
    await expect(
      sendRecoveringExpiry(() => Promise.reject(new Error("Blockhash not found")), getStatus),
    ).rejects.toThrow("Blockhash not found");
    expect(getStatus).not.toHaveBeenCalled();
  });
});
