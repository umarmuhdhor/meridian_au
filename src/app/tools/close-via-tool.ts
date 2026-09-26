import type { AppContext } from "./context.js";
import type { ToolRegistry } from "./registry.js";
import type { CloseResult } from "../../domain/schemas/chain.js";
import type { DecisionActor } from "../../domain/schemas/decision.js";
import { executeTool } from "./execute.js";

export type CloseViaToolOutcome =
  | { ok: true; result: CloseResult }
  | { ok: false; error: string };

/**
 * Close a position through the `close_position` tool, never `chain.closePosition`.
 *
 * Every close MUST take this path (or `executeTool` directly): the tool's post-hooks
 * are the only writers of the performance record (dashboard History), the decision
 * log, the pool cooldown and `closed:true` in state.json, and they also send the
 * Telegram card and consolidate base → SOL. The pnl-poller and Telegram /close used
 * to call the chain directly; their closes (mostly smart-exit loss cuts) vanished
 * from History and only reappeared as "reconciled: no longer on-chain" ghosts.
 *
 * Never throws. `ok:false` covers tool errors AND an in-band `success:false`.
 */
export async function closeViaTool(
  registry: ToolRegistry,
  ctx: AppContext,
  positionAddress: string,
  reason: string,
  actor: DecisionActor,
): Promise<CloseViaToolOutcome> {
  const scoped: AppContext = { ...ctx, deployMeta: { actor, rationale: reason } };
  const r = await executeTool(
    registry,
    { name: "close_position", args: { position_address: positionAddress, reason } },
    scoped,
  );
  if (!r.ok) {
    const detail = "reason" in r.error ? r.error.reason : "message" in r.error ? r.error.message : r.error.kind;
    return { ok: false, error: `${r.error.kind}: ${detail}` };
  }
  const result = r.value as CloseResult;
  if (!result.success) return { ok: false, error: `close returned failure (${result.reason})` };
  return { ok: true, result };
}
