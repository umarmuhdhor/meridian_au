import type { AppContext } from "../tools/context.js";
import type { PerformanceRecord } from "../../domain/schemas/lesson.js";
import { isPnlSettled, settledClosePnl } from "../../domain/format/close-pnl.js";
import { perfContextFromTracked } from "../tools/post/record-performance.js";

/** How far back unsettled records are retried — also the one-off backfill horizon. */
export const FINALIZE_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
/** Records reconciled per call; bounds datapi traffic when the backlog is large. */
export const FINALIZE_MAX_PER_TICK = 10;

/** Note the reverse reconcile stamps on a tracked position that vanished on-chain. */
export const RECONCILED_CLOSE_NOTE = "reconciled: no longer on-chain (external close or ghost record)";

/**
 * Give a History row to every position that closed outside a successful `close_position`
 * (Meteora UI, a script, or a close tx reported expired that actually landed). Only
 * `close_position`'s post-hook writes PerformanceRecords, so these closes used to vanish
 * from History and the loss totals. The record starts as a zero estimate and is settled
 * from Meteora by `finalizeClosedPerformance` in the same tick. Covers the whole lookback
 * window, so older reconciled closes are backfilled too.
 */
export async function recordReconciledCloses(ctx: AppContext): Promise<number> {
  const loaded = await ctx.repos.lessons.load();
  if (!loaded.ok) return 0;
  const recorded = new Set(loaded.value.performance.map((p) => p.position));
  const cutoff = ctx.clock.now().getTime() - FINALIZE_LOOKBACK_MS;

  let added = 0;
  for (const t of await ctx.repos.positions.all()) {
    if (!t.closed || !t.pool || recorded.has(t.position)) continue;
    if (!(t.notes ?? []).includes(RECONCILED_CLOSE_NOTE)) continue;
    const closedMs = Date.parse(String(t.closed_at));
    if (!Number.isFinite(closedMs) || closedMs < cutoff) continue;
    const deployedMs = Date.parse(String(t.deployed_at));
    const perf: PerformanceRecord = {
      position: t.position,
      pool: t.pool,
      pool_name: t.pool_name ?? null,
      pnl_pct: 0,
      pnl_usd: 0,
      fees_earned_usd: 0,
      ...(t.initial_value_usd != null ? { initial_value_usd: t.initial_value_usd } : {}),
      pnl_source: "estimate",
      ...(Number.isFinite(deployedMs)
        ? { minutes_held: Math.max(0, Math.round((closedMs - deployedMs) / 60_000)) }
        : {}),
      close_reason: "closed outside close_position (reconciled from chain)",
      ...(t.amount_sol != null ? { amount_sol: t.amount_sol } : {}),
      ...perfContextFromTracked(t),
      closed_at: t.closed_at!,
      recorded_at: ctx.clock.now().toISOString(),
    };
    await ctx.repos.lessons.appendPerformance(perf);
    recorded.add(t.position);
    added++;
    ctx.logger.info("perf", `recorded reconciled close ${t.position.slice(0, 8)} (settles from Meteora)`);
  }
  return added;
}

/**
 * Replace close-time PnL estimates with Meteora's settled closed-position totals.
 *
 * The close hook records an estimate from the last open-position snapshot; the true
 * withdrawal and the fees claimed during the close only land in Meteora's datapi a few
 * seconds later. This pass (run every management tick) looks up each recent record that
 * is not yet settled and overwrites its PnL fields with the numbers Meteora's own UI
 * shows, stamping `pnl_source: "meteora_closed"` so it is never fetched again.
 *
 * Newest first, so a fresh close is settled on the next tick even when older records
 * stay unresolvable (e.g. positions from a different wallet). A lookup that fails or
 * finds nothing leaves the record untouched — retried next tick until the lookback
 * window passes. Never throws: bookkeeping must not break the management cycle.
 */
export async function finalizeClosedPerformance(ctx: AppContext): Promise<number> {
  const lookup = ctx.chain.getClosedPositionPnl?.bind(ctx.chain);
  if (!lookup) return 0;

  const loaded = await ctx.repos.lessons.load();
  if (!loaded.ok) return 0;

  const cutoff = ctx.clock.now().getTime() - FINALIZE_LOOKBACK_MS;
  const pending = loaded.value.performance
    .filter((p): p is PerformanceRecord & { pool: string } => !!p.pool && !isPnlSettled(p))
    .filter((p) => {
      const ts = Date.parse(String(p.closed_at ?? p.recorded_at));
      return Number.isFinite(ts) && ts >= cutoff;
    })
    .reverse()
    .slice(0, FINALIZE_MAX_PER_TICK);

  let settled = 0;
  for (const perf of pending) {
    try {
      const closed = await lookup(perf.pool, perf.position);
      const pnl = closed ? settledClosePnl(closed) : null;
      if (!pnl) continue;
      const ok = await ctx.repos.lessons.updatePerformance(perf.position, {
        pnl_pct: pnl.pnl_pct,
        pnl_usd: pnl.pnl_usd,
        fees_earned_usd: pnl.fees_earned_usd,
        ...(pnl.initial_value_usd != null ? { initial_value_usd: pnl.initial_value_usd } : {}),
        ...(pnl.final_value_usd != null ? { final_value_usd: pnl.final_value_usd } : {}),
        pnl_source: "meteora_closed",
      });
      if (!ok) continue;
      settled++;
      ctx.logger.info("perf", `settled close ${perf.position.slice(0, 8)} from Meteora`, {
        estimate_pnl_usd: perf.pnl_usd,
        estimate_fees_usd: perf.fees_earned_usd,
        pnl_usd: pnl.pnl_usd,
        fees_usd: pnl.fees_earned_usd,
        net_usd: Math.round((pnl.pnl_usd + pnl.fees_earned_usd) * 100) / 100,
        pnl_pct: Math.round(pnl.pnl_pct * 100) / 100,
      });
    } catch (err) {
      ctx.logger.warn("perf", `settle lookup failed for ${perf.position.slice(0, 8)}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return settled;
}
