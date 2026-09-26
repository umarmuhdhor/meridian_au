import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { ChainClient } from "../../ports/chain-client.js";
import type { Scheduler } from "../../ports/scheduler.js";
import type { PositionRepo } from "../../ports/position-repo.js";
import type { FollowRepo } from "../../ports/follow-repo.js";
import type { FollowConfig } from "../../domain/schemas/config.js";
import type { ManagementConfig } from "../../domain/schemas/config.js";
import type { OnChainPosition, PositionsSnapshot } from "../../domain/schemas/chain.js";
import { assessPnl } from "../../domain/rules/pnl.js";
import { partitionMirrorOwnership } from "../../domain/rules/follow-diff.js";
import { getPollerFastCut } from "../../domain/rules/close-rules.js";
import type { CloseViaToolOutcome } from "../tools/close-via-tool.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_CONFIRM_DELAY_MS = 15_000;
const DEFAULT_CONFIRM_TOLERANCE_PCT = 1;

/** A trailing-drop that was seen on a previous tick and is waiting for confirmation. */
export interface PendingConfirm {
  positionAddress: string;
  peakPnlPct: number;
  atQueueTime: number;
  queuedAtMs: number;
  reason: string;
}

/**
 * Pure — returns actions to take + the next pending-confirm queue.
 *
 * Two behaviors interleave every tick:
 *   1. For each currently-pending confirm whose queuedAtMs + confirmDelayMs is past,
 *      re-evaluate the drop against the live snapshot. If it still holds within
 *      `confirmTolerancePct`, fire a `close_confirmed` action; otherwise drop it.
 *   2. For each fresh live position not yet queued, detect a trailing-drop candidate
 *      (peak - current >= trailingDropPct). Queue it — do NOT fire immediately.
 *
 * The mirror pattern in tools/dlmm.js schedules a setTimeout per candidate; this pure
 * version replaces that with a queue the poller inspects each tick, which keeps the
 * whole thing testable with the ManualScheduler.
 */
export function tickPnlPoller(
  pending: PendingConfirm[],
  snapshot: PositionsSnapshot,
  now: Date,
  mgmt: ManagementConfig,
  cfg: { confirmDelayMs: number; confirmTolerancePct: number },
): { next: PendingConfirm[]; actions: Array<{ kind: "close_confirmed" | "fast_cut"; positionAddress: string; reason: string }> } {
  const nowMs = now.getTime();
  const actions: Array<{ kind: "close_confirmed" | "fast_cut"; positionAddress: string; reason: string }> = [];

  // Fast lookup live → snapshot.
  const bySnap = new Map<string, OnChainPosition>();
  for (const p of snapshot.positions) bySnap.set(p.position, p);

  // Smart-exit fast-cut (on-chain only, no OHLCV): CATASTROPHIC floor + OOR-below
  // proxy. Immediate (no two-phase confirm — these states are unambiguous). Gated
  // on smartExitEnabled so the dark-launch default leaves poller behavior unchanged.
  // Positions cut here are skipped by the trailing-TP scan below.
  const fastCutAddrs = new Set<string>();
  if (mgmt.smartExitEnabled) {
    for (const p of snapshot.positions) {
      const reason = getPollerFastCut(
        {
          pnl_pct: p.pnl_pct,
          pnl_pct_suspicious: p.pnl_pct_suspicious,
          total_value_usd: p.total_value_usd ?? null,
          active_bin: p.active_bin,
          lower_bin: p.lower_bin,
          age_minutes: p.age_minutes ?? null,
        },
        mgmt,
      );
      if (reason) {
        actions.push({ kind: "fast_cut", positionAddress: p.position, reason });
        fastCutAddrs.add(p.position);
      }
    }
  }

  // 1) Resolve pending confirms that have aged past confirmDelayMs.
  const stillPending: PendingConfirm[] = [];
  const consumedThisTick = new Set<string>();
  for (const q of pending) {
    if (fastCutAddrs.has(q.positionAddress)) continue; // fast-cut supersedes a queued trailing confirm
    if (nowMs - q.queuedAtMs < cfg.confirmDelayMs) {
      stillPending.push(q);
      continue;
    }
    consumedThisTick.add(q.positionAddress); // do not re-queue same tick
    const live = bySnap.get(q.positionAddress);
    if (!live) continue; // position gone (closed elsewhere) — drop from queue silently
    const pnl = assessPnl(live.pnl_pct, null, mgmt.pnlSanityMaxDiffPct);
    if (pnl.pnl_pct_suspicious || pnl.pnl_pct == null) continue; // unpriceable — drop
    const dropNow = q.peakPnlPct - pnl.pnl_pct;
    const dropAtQueue = q.peakPnlPct - q.atQueueTime;
    // Confirm iff the drop is still ≥ dropAtQueue - tolerance (i.e. hasn't recovered).
    if (dropNow >= dropAtQueue - cfg.confirmTolerancePct) {
      actions.push({
        kind: "close_confirmed",
        positionAddress: q.positionAddress,
        reason: q.reason,
      });
    }
    // Whether confirmed or recovered, this pending entry is done.
  }

  // 2) Look at every live position for a NEW trailing-drop candidate.
  if (mgmt.trailingTakeProfit) {
    const pendingKeys = new Set(stillPending.map((p) => p.positionAddress));
    for (const p of snapshot.positions) {
      if (fastCutAddrs.has(p.position)) continue; // being fast-cut this tick
      if (pendingKeys.has(p.position)) continue; // already queued
      if (consumedThisTick.has(p.position)) continue; // already resolved this tick
      // The peak comes from the tracked position — the live snapshot doesn't carry it.
      // Callers merge it in before calling `tickPnlPoller` (see `createPnlPoller`).
      const peak = (p as OnChainPosition & { _peakPnlPct?: number })._peakPnlPct ?? null;
      if (peak == null) continue;
      const pnl = assessPnl(p.pnl_pct, null, mgmt.pnlSanityMaxDiffPct);
      if (pnl.pnl_pct_suspicious || pnl.pnl_pct == null) continue;
      const trailingActive = peak >= mgmt.trailingTriggerPct;
      if (!trailingActive) continue;
      const dropFromPeak = peak - pnl.pnl_pct;
      if (dropFromPeak < mgmt.trailingDropPct) continue;
      stillPending.push({
        positionAddress: p.position,
        peakPnlPct: peak,
        atQueueTime: pnl.pnl_pct,
        queuedAtMs: nowMs,
        reason:
          `Trailing TP confirmed: peak ${peak.toFixed(2)}% → current ${pnl.pnl_pct.toFixed(2)}% ` +
          `(dropped ${dropFromPeak.toFixed(2)}% >= ${mgmt.trailingDropPct}%)`,
      });
    }
  }

  return { next: stillPending, actions };
}

export interface PnlPollerDeps {
  clock: Clock;
  logger: Logger;
  /** Read-only here (positions snapshot). Closes go through `closePosition`. */
  chain: ChainClient;
  /**
   * Performs the close. Production wires this to `closeViaTool` so the
   * `close_position` post-hooks run — performance record (dashboard History),
   * decision log, cooldown, mark-closed, Telegram card, base → SOL. Calling
   * `chain.closePosition` here instead is what made fast-cut losses disappear
   * from History. Should not throw (a throw is caught and logged anyway).
   */
  closePosition: (positionAddress: string, reason: string) => Promise<CloseViaToolOutcome>;
  scheduler: Scheduler;
  positionRepo: PositionRepo;
  config: ManagementConfig;
  /**
   * When both are present AND `followConfig.exclusiveExit` reads true at TICK time,
   * positions held by an open follow mirror are removed from the tick entirely — no
   * trailing-TP queue, no smart-exit fast-cut. The followed wallet owns the exit.
   *
   * `followConfig` must be the LIVE config section (update_config mutates it in place),
   * not a copy: reading it per tick is what makes the flag hot-reloadable instead of
   * pinned to whatever it was at boot. Either absent = poller behaves exactly as before.
   */
  followRepo?: FollowRepo;
  followConfig?: FollowConfig;
  pollIntervalMs?: number;
  confirmDelayMs?: number;
  confirmTolerancePct?: number;
}

export interface PnlPollerHandle {
  stop(): void;
  /** Exposed for tests — read the current in-memory pending queue. */
  peekPending(): PendingConfirm[];
}

/**
 * PnL trailing-TP poller — mirrors CLAUDE.md §"PnL poller" + §"Trailing TP two-phase
 * confirmation". Runs every 30s (configurable). Each tick:
 *
 *   1. Fetches positions with `force: true`.
 *   2. Merges the persisted `peak_pnl_pct` into each live snapshot.
 *   3. Calls `tickPnlPoller` for the pure decision.
 *   4. For every `close_confirmed` / `fast_cut` action, invokes `deps.closePosition`
 *      (the `close_position` tool — see PnlPollerDeps.closePosition).
 *
 * Blocking write path: the closes only fire when the chain client's writes are armed
 * (MERIDIAN_WRITE_UNSAFE=true). Otherwise the close fails; the poller logs and moves on.
 */
export function createPnlPoller(deps: PnlPollerDeps): PnlPollerHandle {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const confirmDelayMs = deps.confirmDelayMs ?? DEFAULT_CONFIRM_DELAY_MS;
  const confirmTolerancePct = deps.confirmTolerancePct ?? DEFAULT_CONFIRM_TOLERANCE_PCT;

  let pending: PendingConfirm[] = [];
  let busy = false;

  async function runTick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const snap = await deps.chain.getMyPositions({ force: true });
      // Drop follow-mirrored positions before any exit logic runs. Filtering here
      // rather than inside `tickPnlPoller` keeps the pure function unaware of the
      // feature, and covers BOTH paths it owns (trailing-TP and the fast-cut).
      //
      // Only mirrors still OWNED by a live, enabled, followed wallet are dropped. Once a
      // mirror is orphaned — master switch off, wallet disabled, wallet removed — nobody
      // is left to close it, so the fast-cut and trailing-TP take it back. The follow
      // cycle closes orphans outright; this covers the gap until it does.
      const followHeld =
        deps.followRepo && deps.followConfig?.exclusiveExit
          ? new Set(
              partitionMirrorOwnership({
                followEnabled: deps.followConfig.enabled,
                wallets: await deps.followRepo.listWallets(),
                openMirrors: await deps.followRepo.listOpenMirrored(),
              }).owned.map((m) => m.position),
            )
          : new Set<string>();
      const eligible =
        followHeld.size > 0
          ? snap.positions.filter((p) => !followHeld.has(p.position))
          : snap.positions;
      // Merge peak_pnl_pct and age from the persisted state into the live snapshot.
      // The chain client leaves age_minutes null; the fast-cut needs it for the pnl
      // warm-up. A position with NO tracked record yet is one the deploy post-hook
      // hasn't written — i.e. seconds old — so it is treated as age 0 (in warm-up).
      // The management cycle forward-reconciles genuinely external positions into
      // tracking within one cycle, after which they get a real age.
      const nowMs = deps.clock.now().getTime();
      const withPeak: PositionsSnapshot = {
        ...snap,
        total_positions: eligible.length,
        positions: await Promise.all(
          eligible.map(async (p) => {
            const tracked = await deps.positionRepo.get(p.position);
            const deployedMs = tracked?.deployed_at ? Date.parse(tracked.deployed_at) : NaN;
            const age =
              p.age_minutes ??
              (!tracked
                ? 0
                : Number.isFinite(deployedMs)
                  ? Math.max(0, Math.floor((nowMs - deployedMs) / 60_000))
                  : null);
            return {
              ...p,
              age_minutes: age,
              _peakPnlPct: tracked?.peak_pnl_pct ?? null,
            } as OnChainPosition;
          }),
        ),
      };
      const { next, actions } = tickPnlPoller(
        pending,
        withPeak,
        deps.clock.now(),
        deps.config,
        { confirmDelayMs, confirmTolerancePct },
      );
      pending = next;

      for (const a of actions) {
        try {
          const label = a.kind === "fast_cut" ? "smart-exit fast-cut" : "trailing-TP confirmed close";
          deps.logger.warn("pnl-poller", `${label} for ${a.positionAddress.slice(0, 8)}…`, {
            reason: a.reason,
          });
          const outcome = await deps.closePosition(a.positionAddress, a.reason);
          if (!outcome.ok) {
            deps.logger.error("pnl-poller", `close failed for ${a.positionAddress.slice(0, 8)}…`, {
              error: outcome.error,
            });
          }
        } catch (err) {
          deps.logger.error(
            "pnl-poller",
            `close_confirmed failed for ${a.positionAddress.slice(0, 8)}…`,
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      }
    } catch (err) {
      deps.logger.error("pnl-poller", "tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      busy = false;
    }
  }

  const handle = deps.scheduler.every(pollIntervalMs, runTick, "pnl-poller");
  return {
    stop: () => handle.cancel(),
    peekPending: () => pending.slice(),
  };
}
