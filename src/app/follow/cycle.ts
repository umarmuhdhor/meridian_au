import type { Scheduler } from "../../ports/scheduler.js";
import type { FollowRepo } from "../../ports/follow-repo.js";
import type { WalletWatcher, WatchedPosition } from "../../ports/wallet-watcher.js";
import type { LLMClient } from "../../ports/llm-client.js";
import type { AppContext } from "../tools/context.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { FollowedWallet, MirroredPosition } from "../../domain/schemas/follow-wallet.js";
import type { DeployResult, CloseResult } from "../../domain/schemas/chain.js";
import {
  describeOrphanCause,
  detectRecenter,
  diffFollowedWallet,
  mirrorCapacity,
  partitionMirrorOwnership,
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
  /**
   * Mirrors closed because their source wallet stopped being followed — the master
   * switch went off, the wallet was disabled, or it was removed. See `drainOrphans`.
   */
  drained: number;
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
 * Ordering matters in two places.
 *
 * Within a wallet, closes run BEFORE opens so a wallet that rotates out of one pool and
 * into another inside a single interval frees its `maxPositions` slot first — otherwise
 * the rotation would be seen as an open that the position cap rejects.
 *
 * Across the tick, the orphan DRAIN runs before the feature switch is honoured. A
 * mirrored position answers to the wallet it was copied from and to nothing else; when
 * that wallet stops being followed the position is closed rather than left behind. That
 * has to happen even on a tick where `follow.enabled` is false, because turning the
 * master switch off is one of the three ways to create an orphan — see `drainOrphans`.
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
    drained: 0,
  };

  const followEnabled = ctx.config.follow.enabled;

  // ONE read of the state file for both the wallet list and the mirror list.
  //
  // This must not go through `listWallets()` / `listOpenMirrored()`, which both answer
  // an unreadable file with an empty array. An empty wallet list is what the drain reads
  // as "every wallet was removed" — so a transient parse failure would be indistinguish-
  // able from a deliberate unfollow and would close every mirrored position. A file we
  // cannot read is not evidence that a wallet is gone. Same reasoning as the datapi
  // `reliable` flag: a failed read is missing information, never an instruction to exit.
  const state = await repo.load();
  if (!state.ok) {
    ctx.logger.warn(
      "follow",
      "follow-state is unreadable — skipping the tick rather than treating an empty wallet list as an unfollow",
    );
    return { ...result, failures: 1 };
  }
  const allWallets = state.value.wallets;
  const wallets = allWallets.filter((w) => w.enabled);
  const openMirrorsAtStart = state.value.mirrored.filter((m) => m.closed_at == null);

  // Fast path out. With no mirrors on the books there is nothing to drain, so a tick
  // that has no work can leave before touching the chain — which is every tick for an
  // installation that does not use the feature.
  if (openMirrorsAtStart.length === 0) {
    if (!followEnabled) return { ...result, kind: "disabled" };
    if (wallets.length === 0) return { ...result, kind: "no_wallets" };
  }

  // One fresh on-chain read per tick, shared across wallets — `force` so the 5-min
  // positions cache cannot hide a position we opened on the previous tick.
  let ourPools: string[] = [];
  // Kept in lockstep with `ourPools` so a drained position can be removed from the
  // capacity count by address — two positions can share a pool, so the pool alone
  // does not identify which entry to drop.
  let ourPositionIdList: string[] = [];
  let ourPositionIds = new Set<string>();
  try {
    const snap = await ctx.chain.getMyPositions({ force: true, silent: true });
    ourPools = snap.positions.map((p) => p.pool);
    ourPositionIdList = snap.positions.map((p) => p.position);
    ourPositionIds = new Set(ourPositionIdList);
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

  // Drain mirrors that no longer have a wallet behind them. Runs AFTER reconcile (so a
  // position that is already gone on-chain is finalised rather than closed again) and
  // BEFORE the feature switch is honoured (so flipping that switch off is itself drained).
  const drain = await drainOrphans(deps, allWallets, followEnabled, (position) => {
    ourPools = ourPools.filter((_, i) => ourPositionIdList[i] !== position);
    ourPositionIdList = ourPositionIdList.filter((id) => id !== position);
  });
  result.drained += drain.drained;
  result.failures += drain.failures;

  // Now the switches may be honoured — every position they would have stranded is shut.
  if (!followEnabled) return { ...result, kind: "disabled" };
  if (wallets.length === 0) return { ...result, kind: "no_wallets" };

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
    // Pools withheld from the baseline so the next tick reconsiders them: a re-center
    // that needs re-mirroring, or an entry we could not read well enough to copy.
    const deferredPools: string[] = [];
    if (ctx.config.follow.mirrorRecenter && snapshot.reliable) {
      const currentSet = new Set(snapshot.pools);
      for (const m of openMirrors) {
        if (!currentSet.has(m.pool)) continue; // exit — handled by diff.closes
        const theirs = await watcher.getPositionsInPool(wallet.address, m.pool);
        if (theirs == null) {
          // Read failed. Closing on that would charge real fees for a re-center we
          // have no evidence of; the check simply waits for the next tick.
          ctx.logger.info(
            "follow",
            `could not read ${wallet.label || short(wallet.address)} in ${m.pool_name ?? short(m.pool)} — skipping the re-center check this tick`,
          );
          continue;
        }
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
        const ok = await mirrorClose(
          deps,
          wallet.label || short(wallet.address),
          m,
          `re-centered: ${verdict.reason}`,
        );
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
      const ok = await mirrorClose(deps, wallet.label || short(wallet.address), mirror);
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
      const outcome = await mirrorOpen(deps, wallet, pool);
      if (outcome === "opened") {
        result.opened++;
        openMirrorCount++;
        ourPools.push(pool);
      } else {
        result.failures++;
        // Withheld from the baseline, so the next tick sees this pool as a fresh entry
        // and reads their position again. Safe precisely because nothing was written.
        if (outcome === "retry") deferredPools.push(pool);
      }
    }

    // The baseline advances to whatever we just observed, whether or not each mirror
    // succeeded. A mirror-open that FAILED AT THE WRITE is not retried: re-attempting a
    // write that may have partially landed is how double-deploys happen, and it is why
    // deploy_position itself is `noRetry`. The failure is logged and notified instead.
    //
    // Two kinds of pool are held back so the next tick reconsiders them — a re-center
    // that must be re-mirrored at their new range, and an entry whose read failed before
    // any write was attempted. The second is safe for exactly the reason the first is:
    // nothing was deployed, so there is nothing that could double.
    const withheld = [...recenteredPools, ...deferredPools];
    if (diff.nextSeen != null) {
      const next =
        withheld.length > 0 ? diff.nextSeen.filter((p) => !withheld.includes(p)) : diff.nextSeen;
      await repo.setSeen(wallet.address, next);
    }
  }

  return result;
}

/**
 * Close every mirrored position that no longer has a followed wallet behind it.
 *
 * `follow.exclusiveExit` gives a mirrored position's exit to the wallet it was copied
 * from and switches off every local rule for it — stop-loss, take-profit, trailing-TP,
 * out-of-range, low-yield, smart-exit. That is the point of copy-trading: our stop
 * should not close a position the wallet we chose to trust is still holding.
 *
 * The arrangement only holds while such a wallet is actually being polled. Three things
 * end that — the master switch goes off, the wallet is disabled, the wallet is removed —
 * and each leaves a position that answers to nobody: the follow cycle will never close
 * it, and the local rules were handed away. So the position is closed instead. Unfollow
 * means unwind.
 *
 * A failed close is deliberately NOT swallowed into success: the record stays open, so
 * the next tick sees the same orphan and tries again. That is the same asymmetry the
 * rest of this file runs on — retrying a close is safe, retrying a deploy is not.
 */
async function drainOrphans(
  deps: FollowCycleDeps,
  allWallets: readonly FollowedWallet[],
  followEnabled: boolean,
  onClosed: (position: string) => void,
): Promise<{ drained: number; failures: number }> {
  const { ctx, repo } = deps;
  // Re-read so the reconcile that just ran is reflected, but through `load` rather than
  // `listOpenMirrored`, which cannot distinguish "no mirrors" from "file unreadable".
  // Draining on a failed read would close positions on a parse error. The caller already
  // refuses the tick in that case; this keeps the guarantee local to the write path too.
  const state = await repo.load();
  if (!state.ok) return { drained: 0, failures: 1 };

  const { orphaned } = partitionMirrorOwnership({
    followEnabled,
    wallets: allWallets,
    openMirrors: state.value.mirrored.filter((m) => m.closed_at == null),
  });
  if (orphaned.length === 0) return { drained: 0, failures: 0 };

  const causes = [...new Set(orphaned.map((o) => describeOrphanCause(o.cause)))].join("; ");
  ctx.logger.warn(
    "follow",
    `${orphaned.length} mirrored position(s) have no followed wallet left (${causes}) — closing them`,
  );
  // Announced BEFORE the writes, not after: these are real on-chain closes the operator
  // did not ask for directly, and they should read the reason even if a close then fails.
  await ctx.notifier.notify(
    "warn",
    `follow: closing ${orphaned.length} mirrored position(s) — ${causes}. ` +
      `A mirror's exit belongs to the wallet it was copied from; with that wallet no ` +
      `longer followed, nothing would ever close it.`,
  );

  let drained = 0;
  let failures = 0;
  for (const { mirror, cause } of orphaned) {
    const label = mirror.source_label || short(mirror.source_wallet);
    const ok = await mirrorClose(
      deps,
      label,
      mirror,
      `is no longer followed (${describeOrphanCause(cause)}) — unwinding our mirror`,
    );
    if (ok) {
      drained++;
      onClosed(mirror.position);
    } else {
      failures++;
      ctx.logger.warn(
        "follow",
        `could not drain mirror ${short(mirror.position)} — it stays open and is retried next tick`,
      );
    }
  }
  return { drained, failures };
}

/**
 * Outcome of one mirror-open attempt.
 *
 * `retry` and `abandoned` both mean no position was opened; they differ in what the
 * caller does with the baseline. A read that failed BEFORE any write was attempted says
 * nothing about the entry we were trying to copy, so that pool is withheld from the
 * baseline and reconsidered next tick. A decision (they hold nothing, the size is below
 * the minimum) and a failed deploy both advance the baseline — the first because there
 * is nothing to copy, the second because re-attempting a write that may have partially
 * landed is how double-spends happen, which is why `deploy_position` is `noRetry`.
 */
type MirrorOpenOutcome = "opened" | "abandoned" | "retry";

async function mirrorOpen(
  deps: FollowCycleDeps,
  wallet: FollowedWallet,
  pool: string,
): Promise<MirrorOpenOutcome> {
  const { ctx, registry, watcher, repo } = deps;
  const cfg = ctx.config.follow;
  const label = wallet.label || short(wallet.address);

  const theirPositions = await watcher.getPositionsInPool(wallet.address, pool);
  if (theirPositions == null) {
    // We cannot see the trade we are meant to be copying. Opening anyway would put us
    // in the right pool at a guessed range with no record of theirs — which also costs
    // this mirror its re-center detection permanently, since that keys on their position
    // address and lower bin. Wait a tick and read again instead.
    ctx.logger.warn(
      "follow",
      `cannot read ${label}'s position in ${short(pool)} — deferring the mirror to the next tick rather than guessing their range`,
    );
    return "retry";
  }
  const source = pickSourcePosition(theirPositions);
  if (source == null) {
    // The read succeeded and they hold nothing here — they left between the portfolio
    // poll and this one. Nothing to copy, and no reason to keep looking.
    //
    // Warn rather than info: the two datapi endpoints are contradicting each other
    // (portfolio says they are in this pool, positions says they hold nothing), which is
    // normal exactly once for a same-tick rotation and a standing bug if it repeats. A
    // /pnl response shape we stopped understanding would otherwise mean follow quietly
    // never mirrors anything again.
    ctx.logger.warn(
      "follow",
      `${label} appears in ${short(pool)} but holds no position there — nothing to mirror`,
    );
    return "abandoned";
  }

  let activeBin: number;
  let binStep: number | undefined;
  try {
    const bin = await ctx.chain.getActiveBin(pool);
    activeBin = bin.binId;
  } catch (e) {
    ctx.logger.warn("follow", `cannot read active bin for ${short(pool)} — retrying next tick`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return "retry";
  }

  // Pool metadata is nice-to-have (name, base mint, bin step for the notification).
  // Never let its absence block the mirror — that is the entire point of this path.
  let poolName: string | null = source.pool_name;
  let baseMint: string | null = source.base_mint;
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
    ctx.logger.warn("follow", "cannot read wallet balance — retrying next tick", {
      error: e instanceof Error ? e.message : String(e),
    });
    return "retry";
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
    // A decision, not a read failure: retrying every tick would just repeat the alert.
    return "abandoned";
  }

  const range = planMirrorRange({
    activeBin,
    sourceLowerBin: source.lower_bin,
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
      their_lower_bin: source.lower_bin,
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
    // The write was attempted. Never retried — see MirrorOpenOutcome.
    return "abandoned";
  }

  const deployed = res.value as DeployResult;
  if (!deployed.success || !deployed.position_address) {
    ctx.logger.warn("follow", `mirror open returned unsuccessful for ${short(pool)}`);
    await ctx.notifier.notify(
      "warn",
      `follow: mirror of ${label} into ${poolName ?? short(pool)} did not complete — not retried`,
    );
    return "abandoned";
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
    source_position: source.position,
    opened_at: ctx.clock.now().toISOString(),
    closed_at: null,
    close_reason: null,
    amount_sol: sized.amountSol,
    lower_bin: deployed.lower_bin,
    upper_bin: deployed.upper_bin,
    source_lower_bin: source.lower_bin,
    source_upper_bin: source.upper_bin,
    source_deposit_sol: source.deposit_sol,
    entry_technicals: entryTechnicals,
    entry_context: {
      active_bin_at_entry: activeBin,
      range_source: range.source,
      clamped_from: range.clampedFrom,
      their_pnl_pct_at_our_entry: source.pnl_pct,
      wallet_sol_at_entry: walletSol,
    },
    exit_technicals: null,
    exit_context: null,
    source_pnl_pct: null,
    lesson_id: null,
  };
  await repo.addMirrored(record);
  return "opened";
}

/**
 * Close one mirrored position.
 *
 * Takes a display LABEL rather than the wallet record on purpose: the drain path closes
 * mirrors whose wallet has already been removed from the list, so no record exists to
 * pass. Everything this needs about the source is on the mirror itself.
 */
async function mirrorClose(
  deps: FollowCycleDeps,
  label: string,
  mirror: MirroredPosition,
  reasonOverride?: string,
): Promise<boolean> {
  const { ctx, registry, repo, watcher } = deps;
  const reason =
    reasonOverride != null
      ? `follow: ${label} ${reasonOverride} in ${mirror.pool_name ?? short(mirror.pool)}`
      : `follow: ${label} exited ${mirror.pool_name ?? short(mirror.pool)}`;

  // Their final PnL, best-effort — the position is gone from the open list, so this
  // is only available when datapi still serves it. Absence is expected, not an error.
  let theirPnl: number | null = null;
  try {
    const rows = await watcher.getPositionsInPool(mirror.source_wallet, mirror.pool);
    theirPnl = rows == null ? null : (pickSourcePosition(rows)?.pnl_pct ?? null);
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
    drained: 0,
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
    //
    // The disabled case is deliberately NOT short-circuited here. Turning the master
    // switch off is one of the three ways to orphan a mirrored position, and the cycle
    // has to run in order to close what it just orphaned. It reports `disabled` itself
    // once the drain is done — and leaves immediately when there is nothing to drain.
    const intervalMs = deps.intervalMs ?? deps.ctx.config.follow.intervalSec * 1000;
    const nowMs = deps.ctx.clock.now().getTime();
    if (lastRunMs !== 0 && nowMs - lastRunMs < intervalMs) return idle();

    const previousRunMs = lastRunMs;
    lastRunMs = nowMs;
    const out = await run();
    // A tick that found the feature off and had nothing to unwind did no work, so it
    // must not consume the interval budget. Otherwise turning follow ON would wait out
    // a full interval before the first poll instead of starting on the next base tick.
    if (out.kind === "disabled" && out.drained === 0 && out.failures === 0) {
      lastRunMs = previousRunMs;
    }
    return out;
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
