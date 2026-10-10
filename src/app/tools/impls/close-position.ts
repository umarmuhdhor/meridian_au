import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { CloseResultSchema } from "../../../domain/schemas/chain.js";
import { logCloseDecision } from "../post/log-decision.js";
import { notifyCloseHook } from "../post/notify.js";
import { consolidateCloseHook } from "../post/consolidate.js";
import { markClosedInRepoHook } from "../post/mark-closed.js";
import { recordPerformanceHook } from "../post/record-performance.js";
import { setCooldownOnCloseHook } from "../post/set-cooldown.js";
import { enrichCloseResult } from "../../../domain/format/enrich-close.js";

const ArgsSchema = z.object({
  position_address: z.string().min(1),
  reason: z.string().min(1).describe("Human-readable reason — becomes the close_reason on the performance record."),
});

export const closePositionTool = defineTool({
  name: "close_position",
  description:
    "Close a Meteora DLMM position, withdrawing all liquidity. Locks after a successful close (oncePerSession) — retriable only on failure.",
  args: ArgsSchema,
  result: CloseResultSchema,
  oncePerSession: true,
  post: [markClosedInRepoHook, setCooldownOnCloseHook, recordPerformanceHook, notifyCloseHook, logCloseDecision("MANAGER"), consolidateCloseHook],
  execute: async ({ position_address, reason }, ctx) => {
    // Snapshot the position before closing so we can enrich the CloseResult
    // (real chain client returns null pnl/value/fees). If the position is
    // missing from the current snapshot (already closed elsewhere), skip
    // enrichment and let the raw result flow through.
    let snapshot;
    try {
      // force: the cached snapshot can be minutes old, and it is the PnL we record.
      const snap = await ctx.chain.getMyPositions({ force: true });
      snapshot = snap.positions.find((p) => p.position === position_address);
    } catch {
      snapshot = undefined;
    }
    // Peak, deposit and deploy time live only in the tracked record (the live
    // snapshot doesn't carry them); the close card shows all three.
    const tracked = await ctx.repos.positions.get(position_address).catch(() => null);
    const deployedMs = tracked ? Date.parse(tracked.deployed_at) : Number.NaN;
    const raw = await ctx.chain.closePosition(position_address, reason);
    return enrichCloseResult(
      raw,
      snapshot,
      tracked
        ? {
            peak_pnl_pct: tracked.peak_pnl_pct ?? null,
            amount_sol: tracked.amount_sol,
            age_minutes: Number.isFinite(deployedMs)
              ? Math.max(0, Math.floor((ctx.clock.now().getTime() - deployedMs) / 60_000))
              : null,
            pool_name: tracked.pool_name ?? null,
            initial_value_usd: tracked.initial_value_usd ?? null,
          }
        : null,
    );
  },
});
