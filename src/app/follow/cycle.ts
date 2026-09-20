import type { Scheduler } from "../../ports/scheduler.js";
import type { FollowRepo } from "../../ports/follow-repo.js";
import type { WalletWatcher, WatchedPosition } from "../../ports/wallet-watcher.js";
import type { LLMClient } from "../../ports/llm-client.js";
import type { AppContext } from "../tools/context.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { FollowedWallet, MirroredPosition } from "../../domain/schemas/follow-wallet.js";
import type { DeployResult, CloseResult } from "../../domain/schemas/chain.js";
import {
  detectRecenter,
  diffFollowedWallet,
  mirrorCapacity,
  planMirrorRange,
  planMirrorSize,
} from "../../domain/rules/follow-diff.js";
import { executeTool } from "../tools/execute.js";
import { captureTechnicals, runFollowRetrospective } from "./learn.js";

export interface FollowCycleDeps {
  ctx: AppContext;
  registry: ToolRegistry;
  watcher: WalletWatcher;
  repo: FollowRepo;
  /** Optional — enables the post-close retrospective. */
  llm?: LLMClient | undefined;
  model?: string | undefined;
  /**
   * Consecutive degraded-snapshot count per wallet, owned by the caller so it survives
   * across ticks. Absent → the stale-snapshot alert is skipped.
   */
  staleCounters?: Map<string, number>;
}

export interface FollowWatcherDeps extends FollowCycleDeps {
  scheduler: Scheduler;
  intervalMs?: number;
}

export interface FollowWatcherHandle {
  stop(): void;
  /** Run one tick now. Exposed for tests and for a manual Telegram/dashboard trigger. */
  runOnce(): Promise<FollowCycleResult>;
}

export interface FollowCycleResult {
  kind: "disabled" | "no_wallets" | "ran";
  seeded: string[];
  opened: number;
  closed: number;
  failures: number;
  /** Mirror records finalised because their position was already gone on-chain. */
  reconciled: number;
  /** Mirrors closed because the source wallet re-centered inside the same pool. */
  recentered: number;
  /** Opens dropped this tick because no mirror slot was free. */
  capped: number;
}

const short = (s: string): string => `${s.slice(0, 8)}…`;

/**
 * How long a mirror record is protected from the reverse-reconcile sweep.
 *
 * A deploy returns its position address before the RPC we read from is guaranteed to
 * serve it. Without this window the very next tick could see a freshly opened mirror
 * missing from `getMyPositions`, finalise the record, and orphan a position that is
 * genuinely open on-chain — which under `follow.exclusiveExit` nothing else would ever
 * close. Generous on purpose: the sweep exists to clean up records whose positions
 * closed minutes-to-hours ago, so nothing is lost by waiting.
 */
export const RECONCILE_GRACE_MS = 3 * 60_000;

/**
 * Pick the position to mirror when a wallet holds several in one pool: the widest
 * range, which is the one carrying the most of their exposure. Ties keep the first.
 */
function pickSourcePosition(positions: readonly WatchedPosition[]): WatchedPosition | null {
  let best: WatchedPosition | null = null;
  let bestWidth = -1;
  for (const p of positions) {
    const width =
      p.lower_bin != null && p.upper_bin != null ? p.upper_bin - p.lower_bin : 0;
    if (width > bestWidth) {
      best = p;
      bestWidth = width;
    }
  }
  return best;
}

/**
 * One follow tick: for every enabled wallet, diff its open pools against the last
 * observation and mirror the difference.
 *
 * Ordering matters. Closes run BEFORE opens so a wallet that rotates out of one pool
 * and into another inside a single interval frees its `maxPositions` slot first —
 * otherwise the rotation would be seen as an open that the position cap rejects.
 */
export async function runFollowCycle(deps: FollowCycleDeps): Promise<FollowCycleResult> {
  const { ctx, repo, watcher } = deps;
  const result: FollowCycleResult = {
    kind: "ran",
    seeded: [],
    opened: 0,
    closed: 0,
    failures: 0,
    reconciled: 0,
    recentered: 0,
    capped: 0,
  };

  if (!ctx.config.follow.enabled) return { ...result, kind: "disabled" };

  const wallets = (await repo.listWallets()).filter((w) => w.enabled);
  if (wallets.length === 0) return { ...result, kind: "no_wallets" };

  // One fresh on-chain read per tick, shared across wallets — `force` so the 5-min
  // positions cache cannot hide a position we opened on the previous tick.
  let ourPools: string[] = [];
  let ourPositionIds = new Set<string>();
  try {
    const snap = await ctx.chain.getMyPositions({ force: true, silent: true });
    ourPools = snap.positions.map((p) => p.pool);
    ourPositionIds = new Set(snap.positions.map((p) => p.position));
  } catch (e) {
    ctx.logger.warn("follow", "could not read our positions — skipping tick", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { ...result, failures: 1 };
  }

  // Reverse reconcile — mirrors the management cycle's ghost-open sweep.
  // A mirror whose position is no longer on-chain (closed manually, from the Meteora
  // UI, or by any path outside this cycle) must be finalised here. Left open it would
  // (a) make `close_position` throw "pool for position … not found in snapshot" when
  // the source wallet eventually exits, and (b) keep matching the `already_mirrored`
  // guard forever, permanently blocking that pool from being mirrored again.
  const nowMs = ctx.clock.now().getTime();
  const nowIso = ctx.clock.now().toISOString();
  for (const m of await repo.listOpenMirrored()) {
    if (ourPositionIds.has(m.position)) continue;
    // Grace window — see RECONCILE_GRACE_MS. An unparseable opened_at is treated as
    // old rather than young: a malformed record should still be reclaimable.
    const openedMs = Date.parse(m.opened_at);
    if (Number.isFinite(openedMs) && nowMs - openedMs < RECONCILE_GRACE_MS) {
      ctx.logger.info(
        "follow",
        `mirror ${short(m.position)} not yet visible on-chain — within the ${RECONCILE_GRACE_MS / 1000}s grace window, leaving it open`,
      );
      continue;
    }
    await repo.updateMirrored(m.position, {
      closed_at: nowIso,
      close_reason: "reconciled: position no longer on-chain (closed outside the follow cycle)",
    });
    result.reconciled++;
    ctx.logger.info(
      "follow",
      `reconciled orphaned mirror ${short(m.position)} in ${m.pool_name ?? short(m.pool)} as closed`,
    );
  }

  // Running count for the capacity check — reconcile has already run, so this is the
  // true number of live mirrors. Adjusted as we open and close within the tick.
  let openMirrorCount = (await repo.listOpenMirrored()).length;

  for (const wallet of wallets) {
    const snapshot = await watcher.getOpenPools(wallet.address);
    const seen = await repo.getSeen(wallet.address);
    const openMirrors = (await repo.listOpenMirrored()).filter(
      (m) => m.source_wallet === wallet.address,
    );

    const diff = diffFollowedWallet({
      seen,
      snapshot,
      ourOpenPools: ourPools,
      openMirrors,
    });

    if (diff.seedOnly) {
      await repo.setSeen(wallet.address, diff.nextSeen ?? []);
      result.seeded.push(wallet.address);
      ctx.logger.info(
        "follow",
        `seeded ${wallet.label || short(wallet.address)} — ${snapshot.pools.length} open pool(s), nothing mirrored`,
      );
      continue;
    }

    if (diff.closesSuppressed) {
      ctx.logger.warn(
        "follow",
        `snapshot for ${wallet.label || short(wallet.address)} incomplete — close detection suppressed this tick`,
      );
      // Suppressing closes is safe against a FALSE exit but not against a MISSED one:
      // while datapi stays degraded the source wallet can leave a pool and we would
      // never mirror it. That matters most under `follow.exclusiveExit`, where these
      // positions have no local stop either — so a sustained outage is escalated to
      // the operator rather than left in the log.
      if (deps.staleCounters) {
        const n = (deps.staleCounters.get(wallet.address) ?? 0) + 1;
        deps.staleCounters.set(wallet.address, n);
        const threshold = ctx.config.follow.staleTicksBeforeAlert;
        if (n === threshold || (n > threshold && n % threshold === 0)) {
          const held = openMirrors.length;
          await ctx.notifier.notify(
            "warn",
            `follow: cannot read ${wallet.label || short(wallet.address)} — ${n} degraded polls in a row. ` +
              `${held} mirrored position(s) will NOT be closed on their exit until this clears` +
              (ctx.config.follow.exclusiveExit ? " (local exit rules are off for these)." : "."),
          );
        }
      }
    } else if (deps.staleCounters?.get(wallet.address)) {
      deps.staleCounters.delete(wallet.address);
      ctx.logger.info("follow", `snapshot for ${wallet.label || short(wallet.address)} recovered`);
    }
    for (const skip of diff.skipped) {
      ctx.logger.info("follow", `skip ${short(skip.pool)} — ${skip.reason}`);
    }

    // Re-center detection — only for pools they are STILL in (an exit is the pool-set
    // diff's job) and only on a snapshot we trust. Costs one datapi call per open mirror.
    const recenteredPools: string[] = [];
    if (ctx.config.follow.mirrorRecenter && snapshot.reliable) {
      const currentSet = new Set(snapshot.pools);
      for (const m of openMirrors) {
        if (!currentSet.has(m.pool)) continue; // exit — handled by diff.closes
        const theirs = await watcher.getPositionsInPool(wallet.address, m.pool);
        const verdict = detectRecenter({
          recordedSourcePosition: m.source_position,
          recordedSourceLowerBin: m.source_lower_bin,
          current: theirs,
          thresholdBins: ctx.config.follow.recenterBinThreshold,
        });
        if (!verdict.recentered) continue;
        ctx.logger.info(
          "follow",
          `${wallet.label || short(wallet.address)} re-centered in ${m.pool_name ?? short(m.pool)} — ${verdict.reason}`,
        );
        const ok = await mirrorClose(deps, wallet, m, `re-centered: ${verdict.reason}`);
        if (ok) {
          result.recentered++;
          openMirrorCount--;
          ourPools = ourPools.filter((p) => p !== m.pool);
          // Drop the pool from the baseline so the NEXT tick reads it as a fresh entry
          // and re-mirrors at their new range. Re-opening in this same tick would race
          // the just-closed position still showing in the on-chain snapshot.
          recenteredPools.push(m.pool);
        } else {
          result.failures++;
        }
      }
    }

    for (const mirror of diff.closes) {
      const ok = await mirrorClose(deps, wallet, mirror);
      if (ok) {
        result.closed++;
        openMirrorCount--;
        ourPools = ourPools.filter((p) => p !== mirror.pool);
      } else {
        result.failures++;
      }
    }

    for (const pool of diff.opens) {
      const capacity = mirrorCapacity({
        ourOpenCount: ourPools.length,
        maxPositions: ctx.config.risk.maxPositions,
        openMirrorCount,
        maxMirrored: ctx.config.follow.maxMirrored,
      });
      if (capacity.slots <= 0) {
        result.capped++;
        ctx.logger.warn(
          "follow",
          `no slot for ${short(pool)} from ${wallet.label || short(wallet.address)} — ` +
            (capacity.blockedBy === "max_mirrored"
              ? `at follow.maxMirrored (${openMirrorCount}/${ctx.config.follow.maxMirrored})`
              : `at risk.maxPositions (${ourPools.length}/${ctx.config.risk.maxPositions})`) +
            ". This entry is skipped and NOT retried.",
        );
        continue;
      }
      const ok = await mirrorOpen(deps, wallet, pool);
      if (ok) {
        result.opened++;
        openMirrorCount++;
        ourPools.push(pool);
      } else {
        result.failures++;
      }
    }

    // The baseline advances to whatever we just observed, whether or not each mirror
    // succeeded. A failed open is NOT retried on the next tick: retrying a write that
    // may have partially landed is how double-deploys happen, and it is why
    // deploy_position itself is `noRetry`. The failure is logged and notified instead.
    // Re-centered pools are withheld so the next tick treats them as new entries.
    if (diff.nextSeen != null) {
      const next =
        recenteredPools.length > 0
          ? diff.nextSeen.filter((p) => !recenteredPools.includes(p))
          : diff.nextSeen;
      await repo.setSeen(wallet.address, next);
    }
  }

  return result;
}

async function mirrorOpen(
  deps: FollowCycleDeps,
  wallet: FollowedWallet,
  pool: string,
): Promise<boolean> {
  const { ctx, registry, watcher, repo } = deps;
  const cfg = ctx.config.follow;
  const label = wallet.label || short(wallet.address);

  const theirPositions = await watcher.getPositionsInPool(wallet.address, pool);
  const source = pickSourcePosition(theirPositions);

  let activeBin: number;
  let binStep: number | undefined;
  try {
    const bin = await ctx.chain.getActiveBin(pool);
    activeBin = bin.binId;
  } catch (e) {
    ctx.logger.warn("follow", `cannot read active bin for ${short(pool)} — skipping mirror`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }

  // Pool metadata is nice-to-have (name, base mint, bin step for the notification).
  // Never let its absence block the mirror — that is the entire point of this path.
  let poolName: string | null = source?.pool_name ?? null;
  let baseMint: string | null = source?.base_mint ?? null;
  try {
    const detail = await ctx.market.pools.getPoolDetail(pool);
    if (detail) {
      poolName = detail.name ?? poolName;
      baseMint = detail.base_mint ?? baseMint;
      binStep = detail.bin_step ?? undefined;
    }
  } catch {
    // non-fatal
  }

  let walletSol = 0;
  try {
    walletSol = (await ctx.chain.getWalletBalance()).sol;
  } catch (e) {
    ctx.logger.warn("follow", "cannot read wallet balance — skipping mirror", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }

  const sized = planMirrorSize({
    walletSol,
    sizePct: wallet.sizePctOverride ?? cfg.positionSizePct,
    gasReserve: ctx.config.management.gasReserve,
    minDeploySol: cfg.minDeploySol,
    maxDeploySol: cfg.maxDeploySol,
  });
  if (!sized.ok) {
    ctx.logger.warn("follow", `cannot size mirror of ${label} in ${short(pool)}: ${sized.reason}`);
    await ctx.notifier.notify(
      "warn",
      `follow: skipped ${poolName ?? short(pool)} from ${label} — ${sized.reason}`,
    );
    return false;
  }

  const range = planMirrorRange({
    activeBin,
    sourceLowerBin: source?.lower_bin ?? null,
    fallbackBinsBelow: cfg.fallbackBinsBelow,
    maxBinsBelow: cfg.maxBinsBelow,
    minBinsBelow: cfg.minBinsBelow,
  });

  ctx.logger.info(
    "follow",
    `mirroring ${label} into ${poolName ?? short(pool)} — ${sized.amountSol} SOL, ${range.binsBelow} bins below (${range.source})`,
    {
      pool,
      active_bin: activeBin,
      their_lower_bin: source?.lower_bin ?? null,
      ...(range.clampedFrom != null ? { clamped_from: range.clampedFrom } : {}),
    },
  );

  // Attribute the write to FOLLOW so the decision log and Telegram card say who
  // this trade came from rather than crediting the screener.
  const rationale =
    `mirrored ${label} (${short(wallet.address)}) entering ${poolName ?? short(pool)}; ` +
    `range ${range.source}` +
    (range.clampedFrom != null ? ` (clamped from ${range.clampedFrom} bins)` : "");
  const followCtx: AppContext = { ...ctx, deployMeta: { actor: "FOLLOW", rationale } };

  const res = await executeTool(
    registry,
    {
      name: "follow_deploy_position",
      args: {
        pool_address: pool,
        amount_sol: sized.amountSol,
        strategy: cfg.strategy,
        bins_below: range.binsBelow,
        bins_above: 0,
        allow_tiny_range: true,
        source_wallet: wallet.address,
        source_label: wallet.label,
        ...(poolName ? { pool_name: poolName } : {}),
        ...(baseMint ? { base_mint: baseMint } : {}),
        ...(binStep != null ? { bin_step: binStep } : {}),
      },
    },
    followCtx,
  );

  if (!res.ok) {
    const detail = "reason" in res.error ? res.error.reason : res.error.kind;
    ctx.logger.warn("follow", `mirror open failed for ${short(pool)}: ${res.error.kind} — ${detail}`);
    await ctx.notifier.notify(
      "warn",
      `follow: could NOT mirror ${label} into ${poolName ?? short(pool)} — ${detail}`,
    );
    return false;
  }

  const deployed = res.value as DeployResult;
  if (!deployed.success || !deployed.position_address) {
    ctx.logger.warn("follow", `mirror open returned unsuccessful for ${short(pool)}`);
    return false;
  }

  // Entry evidence for the retrospective. Captured AFTER the write so a slow
  // GeckoTerminal call never delays the entry itself.
  const entryTechnicals = await captureTechnicals(ctx, pool);

  const record: MirroredPosition = {
    position: deployed.position_address,
    pool,
    pool_name: poolName,
    base_mint: baseMint,
    source_wallet: wallet.address,
    source_label: wallet.label,
    source_position: source?.position ?? null,
    opened_at: ctx.clock.now().toISOString(),
    closed_at: null,
    close_reason: null,
    amount_sol: sized.amountSol,
    lower_bin: deployed.lower_bin,
    upper_bin: deployed.upper_bin,
    source_lower_bin: source?.lower_bin ?? null,
    source_upper_bin: source?.upper_bin ?? null,
    source_deposit_sol: source?.deposit_sol ?? null,
    entry_technicals: entryTechnicals,
    entry_context: {
      active_bin_at_entry: activeBin,
      range_source: range.source,
      clamped_from: range.clampedFrom,
      their_pnl_pct_at_our_entry: source?.pnl_pct ?? null,
      wallet_sol_at_entry: walletSol,
    },
    exit_technicals: null,
    exit_context: null,
    source_pnl_pct: null,
    lesson_id: null,
  };
  await repo.addMirrored(record);
  return true;
}

async function mirrorClose(
  deps: FollowCycleDeps,
  wallet: FollowedWallet,
  mirror: MirroredPosition,
  reasonOverride?: string,
): Promise<boolean> {
  const { ctx, registry, repo, watcher } = deps;
  const label = wallet.label || short(wallet.address);
  const reason =
    reasonOverride != null
      ? `follow: ${label} ${reasonOverride} in ${mirror.pool_name ?? short(mirror.pool)}`
      : `follow: ${label} exited ${mirror.pool_name ?? short(mirror.pool)}`;

  // Their final PnL, best-effort — the position is gone from the open list, so this
  // is only available when datapi still serves it. Absence is expected, not an error.
  let theirPnl: number | null = null;
  try {
    const rows = await watcher.getPositionsInPool(wallet.address, mirror.pool);
    theirPnl = pickSourcePosition(rows)?.pnl_pct ?? null;
  } catch {
    // non-fatal
  }

  // Our PnL must be read BEFORE the close — afterwards the position is gone.
  let ourPnl: number | null = null;
  try {
    const snap = await ctx.chain.getMyPositions({ silent: true });
    ourPnl = snap.positions.find((p) => p.position === mirror.position)?.pnl_pct ?? null;
  } catch {
    // non-fatal
  }

  const exitTechnicals = await captureTechnicals(ctx, mirror.pool);

  const followCtx: AppContext = {
    ...ctx,
    deployMeta: { actor: "FOLLOW", rationale: reason },
  };
  const res = await executeTool(
    registry,
    { name: "close_position", args: { position_address: mirror.position, reason } },
    followCtx,
  );

  const now = ctx.clock.now().toISOString();

  if (!res.ok) {
    const detail = "reason" in res.error ? res.error.reason : res.error.kind;
    ctx.logger.warn(
      "follow",
      `mirror close failed for ${short(mirror.position)}: ${res.error.kind} — ${detail}`,
    );
    await ctx.notifier.notify(
      "warn",
      `follow: could NOT close our mirror of ${mirror.pool_name ?? short(mirror.pool)} — ${detail}. Position still open. (${reason})`,
    );
    return false;
  }

  const closed = res.value as CloseResult;
  if (closed.final_pnl_pct != null) ourPnl = closed.final_pnl_pct;

  const finalRecord: MirroredPosition = {
    ...mirror,
    closed_at: now,
    close_reason: reason,
    exit_technicals: exitTechnicals,
    exit_context: { our_pnl_pct_at_exit: ourPnl, their_pnl_pct_at_exit: theirPnl },
    source_pnl_pct: theirPnl,
  };
  await repo.updateMirrored(mirror.position, finalRecord);

  ctx.logger.info(
    "follow",
    `mirrored close of ${mirror.pool_name ?? short(mirror.pool)} — our PnL ${ourPnl?.toFixed(2) ?? "?"}%, theirs ${theirPnl?.toFixed(2) ?? "?"}%`,
  );

  if (ctx.config.follow.learnEnabled) {
    const outcome = await runFollowRetrospective(
      { ctx, llm: deps.llm, model: deps.model },
      finalRecord,
      ourPnl,
    );
    if (outcome.lessonId) {
      await repo.updateMirrored(mirror.position, { lesson_id: outcome.lessonId });
      ctx.logger.info("follow", `retrospective lesson ${outcome.lessonId}: ${outcome.rule}`);
      await ctx.notifier.notify(
        "info",
        `follow retrospective — ${mirror.pool_name ?? short(mirror.pool)}\n` +
          `entry: ${outcome.entry ?? "?"}\nexit: ${outcome.exit ?? "?"}\nlesson: ${outcome.rule}`,
      );
    }
  }

  return true;
}

/**
 * Base scheduler cadence. Matches the schema minimum for `follow.intervalSec`, so the
 * configured interval is always an exact multiple of ticks we can gate on.
 */
export const FOLLOW_BASE_TICK_MS = 15_000;

/**
 * Schedule the follow cycle.
 *
 * The watcher is created unconditionally and decides at TICK time whether to run.
 * Gating at construction time instead would pin `follow.enabled`, `intervalSec`,
 * `exclusiveExit` and `learnEnabled` to their boot values, so toggling any of them from
 * the dashboard would appear to save and then do nothing until the next restart —
 * `update_config` mutates each config section in place precisely so a running daemon can
 * pick changes up. The cost of an idle watcher is one no-op timer every 15s.
 *
 * Overlap-skip comes from the scheduler; the local busy flag additionally stops a manual
 * `runOnce` from interleaving with a scheduled tick.
 */
export function createFollowWatcher(deps: FollowWatcherDeps): FollowWatcherHandle {
  // Lives for the process, not the tick — the alert needs a run of consecutive failures.
  const staleCounters = new Map<string, number>();
  let busy = false;
  let lastRunMs = 0;
  const idle = (): FollowCycleResult => ({
    kind: "ran",
    seeded: [],
    opened: 0,
    closed: 0,
    failures: 0,
    reconciled: 0,
    recentered: 0,
    capped: 0,
  });

  const run = async (): Promise<FollowCycleResult> => {
    if (busy) return idle();
    busy = true;
    try {
      return await runFollowCycle({ ...deps, staleCounters });
    } catch (e) {
      deps.ctx.logger.warn("follow", "cycle threw", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ...idle(), failures: 1 };
    } finally {
      busy = false;
    }
  };

  const scheduledTick = async (): Promise<FollowCycleResult> => {
    // Read live on every tick, never captured at construction.
    if (!deps.ctx.config.follow.enabled) return { ...idle(), kind: "disabled" };
    const intervalMs = deps.intervalMs ?? deps.ctx.config.follow.intervalSec * 1000;
    const nowMs = deps.ctx.clock.now().getTime();
    if (lastRunMs !== 0 && nowMs - lastRunMs < intervalMs) return idle();
    lastRunMs = nowMs;
    return run();
  };

  const handle = deps.scheduler.every(
    FOLLOW_BASE_TICK_MS,
    () => scheduledTick().then(() => {}),
    "follow",
  );
  return {
    stop: () => handle.cancel(),
    // Manual trigger bypasses the interval gate but not the feature switch —
    // runFollowCycle reports `disabled` on its own.
    runOnce: run,
  };
}
