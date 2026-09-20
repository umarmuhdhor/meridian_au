import type { AppContext } from "../tools/context.js";
import type { LLMClient } from "../../ports/llm-client.js";
import type { SageDecider } from "../../ports/sage-decider.js";
import type { ToolRegistry } from "../tools/registry.js";
import { runAgentLoop, type AgentLoopResult } from "../agent/loop.js";
import { executeTool } from "../tools/execute.js";
import { buildSystemPrompt } from "../../domain/prompt/builder.js";
import { SCREENER_TOOLS } from "../../domain/prompt/role-tools.js";
import { sanitizeDecisionText } from "../../domain/schemas/decision.js";
import type { CandidatePool } from "../../domain/schemas/market.js";
import {
  formatInsufficientSolReason,
  formatMaxPositionsReason,
  formatNoCandidatesReason,
} from "../../domain/format/decision-strings.js";
import {
  computeCandidateHistory,
  computePortfolioAggregate,
  formatCandidateHistoryLine,
  formatPortfolioAggregate,
} from "../../domain/format/candidate-history.js";
import type { PerformanceRecord } from "../../domain/schemas/lesson.js";
import { computeTechnicals, formatTechnicalsBlock } from "../../domain/format/technicals.js";
import type { KlineTimeframe, TechnicalsSummary } from "../../domain/schemas/kline.js";

export interface ScreeningCycleDeps {
  ctx: AppContext;
  llm: LLMClient;
  registry: ToolRegistry;
  model: string;
  /**
   * Who makes the deploy decision. "loop" (default) = local LLM ReAct loop.
   * "sage" = delegate to an external agent that reasons with memory AND executes
   * the deploy itself via the dashboard bridge; the local loop becomes the fallback.
   */
  decider?: "loop" | "sage";
  sage?: SageDecider;
  /** Memory scope for the Sage session (X-Hermes-Session-Key). */
  sageSessionKey?: string;
  /** Hard timeout for a Sage delegation before falling back. */
  sageTimeoutMs?: number;
}

export type ScreeningOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "no_deploy"; picked: number; rejection_summary: readonly string[] }
  | { kind: "invoked"; picked: number; agent: AgentLoopResult }
  | { kind: "delegated"; picked: number; deployed: boolean; text: string };

function nextDecisionId(now: Date): string {
  return `dec_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** DRY helper: append a `no_deploy` decision so the Decisions page is never silent. */
async function appendNoDeploy(
  ctx: AppContext,
  args: { summary: string; reason: string; metrics: Record<string, unknown>; rejected?: string[] },
): Promise<void> {
  await ctx.repos.decisions.append({
    id: nextDecisionId(ctx.clock.now()),
    ts: ctx.clock.now().toISOString(),
    type: "no_deploy",
    actor: "SCREENER",
    pool: null,
    pool_name: null,
    summary: sanitizeDecisionText(args.summary),
    reason: sanitizeDecisionText(args.reason, 500),
    risks: [],
    metrics: args.metrics,
    rejected: args.rejected ?? [],
  });
}

interface TopCandidatesResult {
  picked: Array<{ pool: CandidatePool; score: number; rank: number }>;
  scanned: number;
  passed: number;
  rejected: number;
  rejection_summary: string[];
  rejected_details: string[];
}

interface Diligence {
  rug?: { score: number; top10_pct: number; passes: boolean; reason: string | null };
  /** total from discovery (pool.holders — authoritative), concentration from getHolders top-10 fetch. */
  holders?: { total: number | null; top10_pct: number | null; bot_pct: number | null };
  error?: string;
}

/** Technicals per shortlisted candidate — one entry per configured timeframe, fail-open. */
type CandidateTechnicals = TechnicalsSummary[];

const SCREENING_TIMEFRAMES: readonly KlineTimeframe[] = ["15m", "1h"] as const;
const SCREENING_KLINE_LIMIT = 100;
const SCREENING_KLINE_TIMEOUT_MS = 3_500;

/**
 * Pre-fetch OHLCV for each shortlisted candidate on the configured timeframes,
 * compute the technicals summary, and return one array per candidate. Parallel
 * per (candidate × timeframe), 3.5s per-call timeout, fails open — a rate-limit
 * or missing history drops that timeframe's line but never blocks the cycle.
 *
 * The result flows into `formatCandidatesBlock`, which appends a `technicals:`
 * block per candidate so the decider (Sage or local loop) sees inline signals
 * for spike detection, support proximity, trend, volatility — WITHOUT having
 * to call a tool inside the 90s delegation budget.
 */
async function enrichTechnicals(
  picked: TopCandidatesResult["picked"],
  ctx: AppContext,
): Promise<CandidateTechnicals[]> {
  const timeout = <T,>(p: Promise<T>): Promise<T | null> =>
    Promise.race([
      p,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SCREENING_KLINE_TIMEOUT_MS)),
    ]);

  const windowShort = ctx.config.screening.technicalsWindowShort;
  // Reuse minTokenAgeHours as the adaptive floor (candle count). If the age gate is off
  // (null), fall back to 3 so results stay meaningful. `minTokenAgeHours` is expressed
  // in hours; on the 1h timeframe that's a 1:1 candle-count floor. On finer timeframes
  // (5m) it's trivially satisfied — a token old enough to pass the age gate always has
  // ≥ minTokenAgeHours candles at 5m.
  const windowMin = Math.max(3, Math.floor(ctx.config.screening.minTokenAgeHours ?? 3));

  return Promise.all(
    picked.map(async (p): Promise<CandidateTechnicals> => {
      const rows = await Promise.all(
        SCREENING_TIMEFRAMES.map(async (tf) => {
          const candles = await timeout(
            ctx.market.kline.getKline(p.pool.pool_address, tf, { limit: SCREENING_KLINE_LIMIT }),
          ).catch(() => null);
          return computeTechnicals(candles ?? [], tf, { windowShort, windowMin });
        }),
      );
      return rows;
    }),
  );
}

/**
 * Pre-enrich each candidate with fresh diligence data (rug + holder concentration)
 * so Sage's autonomous cycle has everything it needs inline — no extra tool calls,
 * no timeout risk from serial GMGN-style lookups. Parallel fetch per candidate,
 * fails open (a missing/failed lookup drops that line, does NOT block the cycle).
 * Budgeted at ~3s per candidate via Promise.race with a timeout.
 */
async function enrichCandidates(
  picked: TopCandidatesResult["picked"],
  ctx: AppContext,
  perCallTimeoutMs = 3000,
): Promise<Diligence[]> {
  const timeout = <T,>(p: Promise<T>): Promise<T | null> =>
    Promise.race([
      p,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), perCallTimeoutMs)),
    ]);

  return Promise.all(
    picked.map(async (p): Promise<Diligence> => {
      const mint = p.pool.base_mint;
      if (!mint) return {};
      try {
        const [rug, holdersLookup] = await Promise.all([
          timeout(ctx.market.rugCheck.check(mint)).catch(() => null),
          timeout(ctx.market.tokenInfo.getHolders(mint, 10)).catch(() => null),
        ]);
        const out: Diligence = {};
        if (rug)
          out.rug = {
            score: rug.score,
            top10_pct: rug.top10_pct,
            passes: rug.passes,
            reason: rug.reason,
          };
        // Total holder count = pool.holders from discovery (authoritative, populated
        // by meteora datapi's base_token_holders). getHolders.count is only the number
        // of TOP-10 rows that parsed — it's ≤10 by definition, so treating it as "total
        // holders" was the "holders=0" bug that made Sage reject valid candidates.
        // top10_pct and bot_pct come from the getHolders response — null when the API
        // returned nothing parseable (Sage can then correctly flag "concentration unknown").
        const total = p.pool.holders ?? null;
        const gotTop10 = holdersLookup !== null && holdersLookup.top.length > 0;
        if (total != null || gotTop10) {
          out.holders = {
            total,
            top10_pct: gotTop10 ? holdersLookup!.top10_pct : null,
            bot_pct: gotTop10 ? holdersLookup!.bot_pct : null,
          };
        }
        return out;
      } catch (e) {
        return { error: (e as Error).message ?? String(e) };
      }
    }),
  );
}

function formatCandidatesBlock(
  picked: TopCandidatesResult["picked"],
  diligence?: readonly Diligence[],
  performance?: readonly PerformanceRecord[],
  now?: Date,
  technicals?: readonly CandidateTechnicals[],
): string {
  if (!picked.length) return "  (no candidates passed)";
  const perfHistory = performance ?? [];
  const clock = now ?? new Date();
  return picked
    .map((p, i) => {
      const feeTvl = p.pool.fee_active_tvl_ratio ?? p.pool.fee_tvl_ratio ?? 0;
      const vol = p.pool.volume_window;
      const mcap = p.pool.mcap != null ? ` mcap=$${p.pool.mcap.toFixed(0)}` : "";
      const holders = p.pool.holders != null ? ` holders=${p.pool.holders}` : "";
      const binStep = p.pool.bin_step != null ? ` bin_step=${p.pool.bin_step}` : "";
      const volSig = p.pool.volatility != null ? ` volatility=${p.pool.volatility.toFixed(3)}` : "";
      const base = `  [${i + 1}] ${p.pool.name}  pool=${p.pool.pool_address}  score=${p.score.toFixed(0)}  fee/aTVL=${(feeTvl * 100).toFixed(2)}% (fee_tvl_ratio=${feeTvl.toFixed(4)})  vol=$${vol.toFixed(0)}  organic=${p.pool.organic_score ?? "?"}${mcap}${holders}${binStep}${volSig}`;
      const d = diligence?.[i];
      if (!d) return base;
      const parts: string[] = [];
      if (d.rug) {
        parts.push(
          `rug_score=${d.rug.score.toFixed(0)}${d.rug.passes ? "" : " FAIL"}${d.rug.reason ? ` (${d.rug.reason})` : ""}`,
        );
      }
      if (d.holders) {
        const h = d.holders;
        const totalStr = h.total != null ? `${h.total}` : "unknown";
        const top10Str = h.top10_pct != null ? `${h.top10_pct.toFixed(1)}%` : "n/a";
        const botsStr = h.bot_pct != null ? `${h.bot_pct.toFixed(1)}%` : "n/a";
        parts.push(`holders=${totalStr}  top10=${top10Str}  bots=${botsStr}`);
      }
      if (d.error) parts.push(`diligence_error=${d.error}`);
      const history = computeCandidateHistory(
        { pool_address: p.pool.pool_address, base_mint: p.pool.base_mint },
        perfHistory,
        clock,
      );
      const historyLine = formatCandidateHistoryLine(history);
      const techRows = technicals?.[i];
      const techBlock = techRows ? formatTechnicalsBlock(techRows) : null;
      const dilLine = parts.length ? `\n       diligence: ${parts.join("  ")}` : "";
      const histLine = historyLine ? `\n       history:   ${historyLine}` : "";
      const techLine = techBlock ? `\n       technicals: ${techBlock}` : "";
      return `${base}${dilLine}${histLine}${techLine}`;
    })
    .join("\n");
}

/**
 * One screening cycle. Order:
 *   1. Preflight — enough SOL? at maxPositions? log skip if so.
 *   2. Run `get_top_candidates`.
 *   3. If 0 pass → append `no_deploy` decision + return `no_deploy`.
 *   4. If ≥1 pass → build system prompt + goal (with candidates block) + invoke agent loop.
 */
export async function runScreeningCycle(deps: ScreeningCycleDeps): Promise<ScreeningOutcome> {
  const { ctx, llm, registry, model } = deps;

  // Preflight
  const [wallet, positionsSnap, activeStrategy, recentDecisions, recentPerformance, lessons] =
    await Promise.all([
      ctx.chain.getWalletBalance(),
      ctx.chain.getMyPositions({ force: true }),
      ctx.repos.strategies.getActive(),
      ctx.repos.decisions.recent(5),
      // Prior closes drive per-candidate history + portfolio-aggregate lines injected
      // into the candidate block; last 50 is enough for meaningful buckets without
      // bloating the prompt.
      ctx.repos.lessons.recentPerformance(50),
      // Pinned + recent lessons feed the LESSONS block — both for the local loop's
      // buildSystemPrompt and (below) for the Sage system prompt, which previously
      // never received them.
      ctx.repos.lessons.listLessons({ limit: 20 }),
    ]);

  if (positionsSnap.total_positions >= ctx.config.risk.maxPositions) {
    // Name the follow feature when it is the reason the screener is boxed out.
    // Mirrors have no local exit under `follow.exclusiveExit`, so they can hold slots
    // indefinitely — without this the log just repeats "at max positions" forever with
    // no hint of where the capacity went, or that follow.maxMirrored is the knob.
    let followHeld = 0;
    try {
      const onChain = new Set(positionsSnap.positions.map((p) => p.position));
      followHeld = (await ctx.repos.follow?.listOpenMirrored() ?? []).filter((m) =>
        onChain.has(m.position),
      ).length;
    } catch {
      // non-fatal — this is diagnostics, never a gate
    }
    const followNote =
      followHeld > 0
        ? ` — ${followHeld} of them held by follow-the-wallet (cap: follow.maxMirrored=${ctx.config.follow?.maxMirrored ?? "?"})`
        : "";
    const shortReason = `at max positions (${positionsSnap.total_positions}/${ctx.config.risk.maxPositions})${followNote}`;
    const humanReason =
      formatMaxPositionsReason(positionsSnap.total_positions, ctx.config.risk.maxPositions) +
      (followHeld > 0
        ? ` ${followHeld} position(s) are follow mirrors, which do not close on local exit rules — lower follow.maxMirrored to reserve room for screening.`
        : "");
    await ctx.repos.decisions.append({
      id: nextDecisionId(ctx.clock.now()),
      ts: ctx.clock.now().toISOString(),
      type: "skip",
      actor: "SCREENER",
      pool: null,
      pool_name: null,
      summary: sanitizeDecisionText(
        `Screening paused — position cap reached (${positionsSnap.total_positions}/${ctx.config.risk.maxPositions})`,
      ),
      reason: sanitizeDecisionText(humanReason, 500),
      risks: [],
      metrics: {
        total_positions: positionsSnap.total_positions,
        max: ctx.config.risk.maxPositions,
        ...(followHeld > 0 ? { follow_held: followHeld } : {}),
      },
      rejected: [],
    });
    ctx.logger.info("screening", `skipped — ${shortReason}`);
    return { kind: "skipped", reason: shortReason };
  }

  const need = ctx.config.management.deployAmountSol + ctx.config.management.gasReserve;
  if (wallet.sol < need) {
    const shortReason = `insufficient SOL: ${wallet.sol.toFixed(4)} < ${need.toFixed(4)}`;
    const humanReason = formatInsufficientSolReason(
      wallet.sol,
      need,
      ctx.config.management.deployAmountSol,
      ctx.config.management.gasReserve,
    );
    await ctx.repos.decisions.append({
      id: nextDecisionId(ctx.clock.now()),
      ts: ctx.clock.now().toISOString(),
      type: "skip",
      actor: "SCREENER",
      pool: null,
      pool_name: null,
      summary: sanitizeDecisionText(`Screening paused — wallet SOL below deploy threshold`),
      reason: sanitizeDecisionText(humanReason, 500),
      risks: [],
      metrics: { sol: wallet.sol, need },
      rejected: [],
    });
    ctx.logger.info("screening", `skipped — ${shortReason}`);
    return { kind: "skipped", reason: shortReason };
  }

  // Run pipeline
  const candidates = await executeTool(registry, {
    name: "get_top_candidates",
    args: { limit: 5, discover_limit: 50 },
  }, ctx);

  if (!candidates.ok) {
    const message = `get_top_candidates failed: ${candidates.error.kind}`;
    ctx.logger.error("screening", message);
    return { kind: "skipped", reason: message };
  }
  const candResult = candidates.value as TopCandidatesResult;
  const picked = candResult.picked;
  const rejSummary = candResult.rejection_summary;
  const rejDetails = candResult.rejected_details ?? [];

  if (picked.length === 0) {
    const humanReason = formatNoCandidatesReason(
      candResult.scanned,
      candResult.rejected,
      rejDetails,
    );
    await ctx.repos.decisions.append({
      id: nextDecisionId(ctx.clock.now()),
      ts: ctx.clock.now().toISOString(),
      type: "no_deploy",
      actor: "SCREENER",
      pool: null,
      pool_name: null,
      summary: sanitizeDecisionText(
        `No pools qualified — reviewed ${candResult.scanned}, all ${candResult.rejected} failed hard filters`,
      ),
      reason: sanitizeDecisionText(humanReason, 500),
      risks: [],
      metrics: {
        scanned: candResult.scanned,
        passed: 0,
        rejected: candResult.rejected,
      },
      rejected: rejDetails.length ? rejDetails : rejSummary,
    });
    ctx.logger.info("screening", `no_deploy — ${rejSummary.slice(0, 3).join(", ")}`);
    return { kind: "no_deploy", picked: 0, rejection_summary: rejSummary };
  }

  // Invoke agent loop
  const systemPrompt = buildSystemPrompt({
    role: "SCREENER",
    wallet,
    positions: positionsSnap,
    config: ctx.config,
    activeStrategy,
    recentDecisions,
    recentPerformance,
    lessons,
  });

  // Pre-fetch fresh diligence (rug + holder concentration) for the shortlist so
  // deciders don't need to make extra tool calls to verify. Sage in autonomous mode
  // can't safely fan out into gmgn-cli / rugcheck (90s timeout, prompt forbids it),
  // and repeated "vetoed 2x, need GMGN-confirmed improvement" no-deploys were the
  // symptom. Pool memory/history changes minute-to-minute — always fresh, never cached.
  const diligenceRaw = await enrichCandidates(picked, ctx);

  // Post-enrichment diligence gate — screening's `maxBotHoldersPct` /
  // `maxTop10Pct` thresholds were declared but never enforced. Rejection reasons
  // existed in the type but no code path returned them, so the caps silently
  // passed everything. Apply them here on the enriched shortlist. Fail-open on
  // unknown data (holders lookup returned nothing → keep the candidate; the LLM
  // still sees `top10=n/a` and can veto).
  const maxBot = ctx.config.screening.maxBotHoldersPct;
  const maxTop10 = ctx.config.screening.maxTop10Pct;
  const dilKept: number[] = [];
  const dilRejected: Array<{ name: string; kind: "bot" | "top10"; value: number; max: number }> = [];
  for (let i = 0; i < picked.length; i++) {
    const d = diligenceRaw[i];
    const bot = d?.holders?.bot_pct;
    const top10 = d?.holders?.top10_pct ?? d?.rug?.top10_pct;
    const poolName = picked[i]?.pool.name ?? "?";
    if (bot != null && bot > maxBot) {
      dilRejected.push({ name: poolName, kind: "bot", value: bot, max: maxBot });
      continue;
    }
    if (top10 != null && top10 > maxTop10) {
      dilRejected.push({ name: poolName, kind: "top10", value: top10, max: maxTop10 });
      continue;
    }
    dilKept.push(i);
  }
  if (dilRejected.length > 0) {
    ctx.logger.info(
      "screening",
      `diligence filter dropped ${dilRejected.length}/${picked.length}`,
      { rejected: dilRejected.map((r) => `${r.name} ${r.kind}=${r.value.toFixed(1)}%>${r.max}%`) },
    );
  }
  let pickedFiltered = dilKept.map((i) => picked[i]!) as typeof picked;
  let diligence = dilKept.map((i) => diligenceRaw[i]!);

  if (pickedFiltered.length === 0) {
    const reason = `All ${picked.length} shortlisted candidate(s) failed diligence caps (bot% > ${maxBot} or top10% > ${maxTop10}).`;
    await appendNoDeploy(ctx, {
      summary: `Diligence filter rejected all ${picked.length} candidates`,
      reason,
      metrics: {
        scanned: (candidates.value as TopCandidatesResult).scanned,
        passed: (candidates.value as TopCandidatesResult).passed,
        candidates: picked.length,
        rejected_diligence: dilRejected.length,
      },
    });
    return { kind: "no_deploy", picked: 0, rejection_summary: dilRejected.map((r) => `${r.kind}_pct_too_high`) };
  }

  // Pre-fetch OHLCV + compute technicals for the diligence-passing shortlist.
  // Same fail-open contract as enrichCandidates — the decider gets whatever
  // resolved in time; missing timeframes just render fewer lines.
  let technicals = await enrichTechnicals(pickedFiltered, ctx);

  // TA hard gate — six failure modes, ALL fail-closed:
  //   1. missing_trend      → every timeframe returned null (too new / wild candles)
  //   2. drawdown           → worst from_window_high_pct < -maxFromHighPct on ANY tf,
  //                           TREND-INDEPENDENT (a bounce reading trend=UP is NOT a recovery)
  //   3. capitulation       → every non-null trend DOWN AND deep + no-support + dead-vol
  //   4. no_floor_downtrend → every non-null trend DOWN AND nearest_support null on every
  //                           candle-bearing tf (falling knife, no floor — QENIS 2026-08-31)
  //   5. atr_extreme        → any timeframe atr_pct > maxAtrPct (deploying into insane vol)
  //   6. spike_top          → any timeframe spike_pct > maxSpikePct AND at_local_top
  //                           (buying the exact top of a pump)
  // 2026-08-11: daemon redeployed a -8.29% loser 1h after close (fixed by cooldown +
  // downtrend gate). 2026-08-13: K-HOME (280x pump, 43% ATR, +57% spike, all trends
  // null) sailed through the downtrend-only gate's fail-open path. This is the fix.
  const maxAtr = ctx.config.screening.maxAtrPct;
  const maxSpike = ctx.config.screening.maxSpikePct;
  const maxFromHigh = ctx.config.screening.maxFromHighPct;
  const rejectNoFloor = ctx.config.screening.rejectNoFloorDowntrend;
  const rejectMissingTrend = ctx.config.screening.rejectOnMissingTrend;
  const capFromHigh = ctx.config.screening.capitulationFromHighPct;
  const capSupportDist = ctx.config.screening.capitulationSupportDistPct;
  const capAtr = ctx.config.screening.capitulationAtrPct;
  const taKept: number[] = [];
  const taRejected: Array<{ name: string; kind: string; detail: string }> = [];
  for (let i = 0; i < pickedFiltered.length; i++) {
    const rows = technicals[i] ?? [];
    const name = pickedFiltered[i]?.pool.name ?? "?";
    const trends = rows.map((r) => r.trend).filter((t): t is "UP" | "DOWN" | "FLAT" => t != null);
    if (trends.length === 0 && rejectMissingTrend) {
      taRejected.push({ name, kind: "missing_trend", detail: "all timeframes returned null" });
      continue;
    }
    // Standalone drawdown veto — TREND-INDEPENDENT. A token deep below its window
    // high is in a downtrend even when the last few candles bounce (trend=UP). The
    // capitulation gate below only fires when EVERY timeframe reads DOWN, so a
    // dead-cat bounce (Zoe -50% / GTA6 -41% / Morty -33% from high, all 1h trend=UP)
    // sailed straight through it. This gate uses the WORST (most negative) from_high
    // across timeframes and rejects regardless of trend. Fail-open only when
    // from_high is genuinely null everywhere (too few candles — already caught by
    // the missing_trend gate when rejectOnMissingTrend is on).
    const fromHighs = rows
      .map((r) => r.from_window_high_pct)
      .filter((v): v is number => v != null);
    const worstFromHigh = fromHighs.length ? Math.min(...fromHighs) : null;
    if (worstFromHigh != null && worstFromHigh < -maxFromHigh) {
      taRejected.push({
        name,
        kind: "drawdown",
        detail: `from_high=${worstFromHigh.toFixed(1)}% below -${maxFromHigh}% (deep drawdown; bounce ≠ recovery)`,
      });
      continue;
    }
    if (trends.length > 0 && trends.every((t) => t === "DOWN")) {
      // Capitulation gate — reject only when the downtrend is BOTH deep AND
      // out of reversal range: deep drawdown from window high, far from support,
      // and dead vol. Shallow dips, near-support setups, and high-vol downtrends
      // pass — those are the bin-sweep / reversal plays DLMM farms fees from.
      const t1h = rows.find((r) => r.timeframe === "1h");
      const fromHigh = t1h?.from_window_high_pct;
      const supportDist = t1h?.support_distance_pct;
      const atr = t1h?.atr_pct;
      const deepDrawdown = fromHigh != null && fromHigh < -capFromHigh;
      const noSupport = supportDist != null && supportDist > capSupportDist;
      const deadVol = atr != null && atr < capAtr;
      if (deepDrawdown && noSupport && deadVol) {
        taRejected.push({
          name,
          kind: "capitulation",
          detail: `1h from_high=${fromHigh!.toFixed(1)}% support_dist=${supportDist!.toFixed(1)}% atr=${atr!.toFixed(1)}%`,
        });
        continue;
      }
      // No-floor downtrend veto — both TFs DOWN AND no swing-low support on ANY
      // candle-bearing timeframe (nearest_support null everywhere = falling knife,
      // nothing under it). QENIS -17% (2026-08-31): both TFs DOWN, support null on
      // 15m+1h, 8-candle red streak; Sage called it a "bin-sweep reversal" and
      // knife-caught it. from_high was only -22% so the drawdown gate (< -35) couldn't
      // catch it. A downtrend with no floor is not a bin-sweep. Code-enforced so Sage
      // can't override it with a thesis. Requires ALL candle rows to lack support (both
      // TFs blind) — a floor on the short TF keeps the candidate.
      if (rejectNoFloor) {
        const candleRows = rows.filter((r) => r.candles > 0);
        const noFloor = candleRows.length > 0 && candleRows.every((r) => r.nearest_support == null);
        if (noFloor) {
          taRejected.push({
            name,
            kind: "no_floor_downtrend",
            detail: `both TFs DOWN + no support on any TF (${candleRows.map((r) => r.timeframe).join("/")})`,
          });
          continue;
        }
      }
    }
    const badAtr = rows.find((r) => r.atr_pct != null && r.atr_pct > maxAtr);
    if (badAtr) {
      taRejected.push({
        name,
        kind: "atr_extreme",
        detail: `${badAtr.timeframe} atr=${badAtr.atr_pct!.toFixed(1)}%>${maxAtr}%`,
      });
      continue;
    }
    const spikeTop = rows.find(
      (r) => r.spike_pct != null && r.spike_pct > maxSpike && r.at_local_top === true,
    );
    if (spikeTop) {
      taRejected.push({
        name,
        kind: "spike_top",
        detail: `${spikeTop.timeframe} spike=+${spikeTop.spike_pct!.toFixed(1)}% at_top`,
      });
      continue;
    }
    taKept.push(i);
  }
  if (taRejected.length > 0) {
    ctx.logger.info(
      "screening",
      `TA gate dropped ${taRejected.length}/${pickedFiltered.length}`,
      { rejected: taRejected.map((r) => `${r.name} ${r.kind}(${r.detail})`) },
    );
  }
  if (taKept.length === 0) {
    const kinds = [...new Set(taRejected.map((r) => r.kind))].join("+");
    const reason = `All ${pickedFiltered.length} diligence-passing candidate(s) failed the TA gate (${kinds}). Rejected: ${taRejected.map((r) => `${r.name}=${r.kind}`).join(", ")}.`;
    await appendNoDeploy(ctx, {
      summary: `TA gate rejected all ${pickedFiltered.length} candidates (${kinds})`,
      reason,
      metrics: {
        scanned: (candidates.value as TopCandidatesResult).scanned,
        passed: (candidates.value as TopCandidatesResult).passed,
        candidates: pickedFiltered.length,
        rejected_ta: taRejected.length,
        rejected_kinds: kinds,
      },
    });
    return {
      kind: "no_deploy",
      picked: 0,
      rejection_summary: taRejected.map((r) => `ta_${r.kind}`),
    };
  }
  pickedFiltered = taKept.map((i) => pickedFiltered[i]!) as typeof pickedFiltered;
  diligence = taKept.map((i) => diligence[i]!);
  technicals = taKept.map((i) => technicals[i]!);

  // Portfolio aggregate — bucketed win/loss stats over the last 30 closes. Shown as
  // context, NOT a rule: the decider may still deploy against a losing bucket if the
  // fresh diligence overrides the historical drift.
  const portfolioAgg = computePortfolioAggregate(recentPerformance, { limit: 30 });
  const portfolioBlock = formatPortfolioAggregate(portfolioAgg);
  const clockNow = ctx.clock.now();

  const goal = [
    "SCREENING CYCLE — pick one of the following candidates and call deploy_position, or explain why none qualify.",
    "",
    "CANDIDATES (fresh diligence + prior history included — do NOT fetch more):",
    formatCandidatesBlock(pickedFiltered, diligence, recentPerformance, clockNow, technicals),
    "",
    portfolioBlock,
    "",
    `Deploy amount: ${ctx.config.management.deployAmountSol} SOL.`,
    `Strategy: choose per candidate {spot|curve|bid_ask} — spot for high-vol meme coins, curve for low-vol range-bound, bid_ask ONLY with a declared directional thesis. Config default "${ctx.config.strategy.strategy}" is a hint, not an order.`,
    `bins_below: ${ctx.config.strategy.binsBelow}.`,
  ].join("\n");

  const scanned = (candidates.value as TopCandidatesResult).scanned;
  const passed = (candidates.value as TopCandidatesResult).passed;

  // Snapshot the set of open position ids BEFORE any deploy. A new id appearing after
  // is our robust "a deploy landed" signal — resilient to a concurrent management
  // close (which removes an OLD id but adds none), unlike a raw count delta.
  const beforeIds = new Set(positionsSnap.positions.map((p) => p.position));
  const detectDeploy = async (): Promise<boolean> => {
    const after = await ctx.chain.getMyPositions({ force: true });
    return after.positions.some((p) => !beforeIds.has(p.position));
  };

  // The local LLM ReAct loop — the default decider (no longer a Sage fallback;
  // fallback was killed 2026-08-26 after the Sue incident where a Sage timeout
  // let the local loop deploy a token Sage had been vetoing for 7 hours).
  const runLocalLoop = async (): Promise<ScreeningOutcome> => {
    // Scoped ctx so any deploy_position call inside the loop tags actor=SCREENER
    // and carries the LLM's rationale — NOT the generic spot template.
    const loopCtx = {
      ...ctx,
      deployMeta: { actor: "SCREENER" as const },
    };
    const agent = await runAgentLoop(
      { llm, registry, ctx: loopCtx },
      {
        role: "SCREENER",
        goal,
        systemPrompt,
        model,
        maxSteps: 8,
        toolFilter: SCREENER_TOOLS,
        requireToolOnFirstStep: true,
      },
    );
    ctx.logger.info(
      "screening",
      `invoked agent — steps=${agent.steps} locks=${agent.locks.join(",")} finish=${agent.finishReason}`,
    );
    // Visibility: if the screener ran but did NOT deploy (it has no "skip" tool, so a
    // decline surfaces as text / no_tool_after_reminder), record WHY. A successful
    // deploy already logs via the tool's post-hook.
    const deployed = agent.toolCalls.some((t) => t.name === "deploy_position" && t.ok);
    if (!deployed) {
      const topPicks = picked
        .slice(0, 3)
        .map((p) => `${p.pool.name} (score ${p.score.toFixed(0)})`)
        .join(", ");
      const rationale = agent.text.trim();
      const reason = [
        `Local LLM reviewed ${picked.length} ranked candidate${picked.length === 1 ? "" : "s"} and declined to open a position.`,
        topPicks ? `Top options: ${topPicks}.` : "",
        rationale ? `Rationale: ${rationale}` : `Loop finished without a deploy call (${agent.finishReason}).`,
      ]
        .filter(Boolean)
        .join(" ");
      await appendNoDeploy(ctx, {
        summary: `Screener passed on all ${picked.length} candidate${picked.length === 1 ? "" : "s"} this cycle`,
        reason,
        metrics: { scanned, passed, candidates: picked.length, finish: agent.finishReason },
      });
      ctx.logger.info("screening", `no_deploy (screener declined) — finish=${agent.finishReason}`);
    }
    return { kind: "invoked", picked: picked.length, agent };
  };

  // Sage delegation path: Sage decides AND deploys via the bridge itself. We only get
  // prose back, so "did a deploy happen?" is answered by reconciliation, not the text.
  if (deps.decider === "sage" && deps.sage) {
    // cycle_id is the deploy idempotency key, shared with the fallback so a
    // delegate→timeout→fallback sequence can't double-deploy (bridge rejects the dup).
    const cycleId = `screen-${ctx.clock.now().toISOString().slice(0, 16)}-${Math.random().toString(36).slice(2, 8)}`;
    // Sage-tailored prompt. Sage's plugin exposes `mrd_`-prefixed tools, NOT Meridian's
    // internal SCREENER toolset — sending Meridian's full SCREENER systemPrompt makes Sage
    // flail (it calls the heavy mrd_get_candidates → CF 502 → timeout). Instead give it the
    // ranked candidates directly and one job: deploy the chosen one via mrd_deploy_position.
    const sageSystemPrompt = [
      "You are Meridian's DLMM screening decider. You are given PRE-FILTERED, RANKED pool",
      "candidates with FRESH DILIGENCE inline (rug_score, total holders count, top10",
      "concentration %, bot share %). Field notes: `holders=N` is the TOTAL holder count",
      "from the pool discovery source (authoritative). `top10=X%` / `bots=Y%` come from a",
      "separate top-10 holder lookup — if that lookup returned nothing the fields render",
      "as `n/a` (unknown), NOT `0.0%`. Zero-value fields mean genuine zero, not missing data.",
      "This is your GMGN-equivalent verification — do NOT go fetch more.",
      "Pick the single best candidate to deploy into, or none.",
      "To deploy, call mrd_deploy_position EXACTLY ONCE with: pool_address (from the chosen",
      "candidate), pool_name (the human-readable name from the candidate line, e.g. \"BONK-SOL\"),",
      "amount_sol, strategy (YOUR choice — see STRATEGY SELECTION below, do NOT default to the",
      "config value), bins_below (given below), bins_above=0, cycle_id (verbatim from the",
      "task), AND rationale (2-3 sentences: WHY this candidate, WHY this strategy, WHICH prior",
      "lesson/veto you're overriding or honoring). The rationale is written to Meridian's",
      "decision log as actor=SAGE — this is how you (and the user) later verify that YOU",
      "deployed this position, not the local screener fallback. A deploy WITHOUT a rationale",
      "field appears in the log as an anonymous SAGE call with the generic spot template as",
      "the reason — that is the failure mode that made the user unable to audit your Sue",
      "deploy on 2026-08-26. ALWAYS pass rationale.",
      "Passing pool_name is REQUIRED — decision-log cards read address prefixes as",
      "gibberish; pool_name is what shows up in the dashboard.",
      "ALSO pass the candidate's diligence context so the position history renders",
      "properly: mcap (from the candidate line), holders (from diligence: holders=N),",
      "volatility, fee_tvl_ratio, organic_score, bin_step (all present on the candidate).",
      "Omit any field that is truly unknown — do not fabricate.",
      "",
      "STRATEGY SELECTION — MANDATORY per cycle. Pick from {spot, curve, bid_ask} based on the",
      "candidate's volatility and thesis. Never copy the config default blindly.",
      "  - spot  → high volatility (>3), uncertain direction, most meme coins. Uniform",
      "            distribution stays in range longest when price swings both ways. DEFAULT",
      "            choice for meme coins.",
      "  - curve → range-bound, low volatility (<2), stable pairs. Concentrates at center for",
      "            max fee efficiency when price barely moves.",
      "  - bid_ask → ONLY with an explicit directional thesis. TWO valid theses: (1) dumping /",
      "              DCA-out / price expected to decline; (2) REVERSAL SETUP — downtrend",
      "              approaching support (support_distance_pct < 5%) with high vol (atr_pct > 20%),",
      "              expect bin sweep + bounce, concentrate at lower bins to catch fees on the flush.",
      "              With bins_above=0 it goes instant-OOR on ANY upward price move — this burned",
      "              Chiikawa, HBULL, MENSA when deployed as autopilot. Forbidden without a stated thesis.",
      "",
      "DOWNTREND HANDLING — a plain 1h DOWN is NOT a veto. DLMM farms fees on volatility crossing",
      "bin range; a downtrend near support with high ATR is a reversal / bin-sweep setup, EXACTLY",
      "what you want. Only veto capitulation: 1h DOWN + from_window_high_pct < -40% + support_distance",
      "> 10% + atr_pct < 15% (deep drop, no bounce, dead vol — nothing to farm even if it reverses).",
      `HARD DRAWDOWN VETO — the code TA gate REJECTS any candidate whose from_window_high_pct is below`,
      `-${ctx.config.screening.maxFromHighPct}% on ANY timeframe, REGARDLESS of trend. A 1h trend=UP on a token`,
      "that is -40% or -50% below its window high is a DEAD-CAT BOUNCE, not a recovery — do NOT read it",
      "as an uptrend and do NOT try to justify deploying into it. Such candidates never reach you; if you",
      "see one in the block, decline it. The code TA gate also fail-closes on capitulation; your job is to",
      "distinguish shallow-dip / near-support / high-vol downtrends (deploy, often bid_ask with reversal",
      "thesis) from slow bleed.",
      "Before calling mrd_deploy_position you MUST state, in one sentence, why the chosen",
      "strategy fits the candidate's volatility (e.g. \"volatility 5.2, meme → spot\").",
      "A cycle that deploys bid_ask without a declared directional thesis in your rationale is",
      "treated as a strategy miss and will be audited.",
      "Do NOT call mrd_get_candidates, mrd_get_positions, mrd_get_wallet, gmgn-cli, or any",
      "other diligence tool — the diligence data is already in the candidate block.",
      "ABSOLUTELY DO NOT call mrd_update_config in this session. Config changes are",
      "human-gated and only permitted when the human user explicitly asks in a chat —",
      "which is NOT this session. This is an autonomous screening cycle, not a user request.",
      "Use your memory of prior vetoes freely — the inline diligence is the fresh signal",
      "that can justify overriding a stale veto (e.g. if a token you vetoed 2 hours ago now",
      "shows improved rug_score / holders / top10 concentration, deploying is defensible).",
      "If none qualify, reply exactly: NO DEPLOY: <reason>.",
    ].join("\n");
    // Lessons (pinned first, then recent) — same summary shape as the local loop's
    // buildSystemPrompt. Injected here because sageSystemPrompt is hand-written and
    // previously carried zero lesson context, so anything the user (or a past
    // Telegram retrospective) pinned was invisible to Sage.
    const sagePinned = lessons.filter((l) => l.pinned).slice(0, 5);
    const sageRecent = lessons.filter((l) => !l.pinned).slice(-5);
    const lessonsParts: string[] = [];
    if (sagePinned.length)
      lessonsParts.push(`PINNED: ${sagePinned.map((l) => l.rule).join(" | ")}`);
    if (sageRecent.length)
      lessonsParts.push(`RECENT: ${sageRecent.map((l) => l.rule).join(" | ")}`);
    const sageLessonsBlock = lessonsParts.length
      ? `\n\n── LESSONS ──\n${lessonsParts.join("\n")}`
      : "";
    const sageSystemPromptWithLessons = sageSystemPrompt + sageLessonsBlock;

    const sageGoal = [
      "SCREENING CYCLE — choose one candidate and call mrd_deploy_position, or NO DEPLOY.",
      "",
      "CANDIDATES (fresh diligence + prior history included — do NOT fetch more):",
      formatCandidatesBlock(pickedFiltered, diligence, recentPerformance, clockNow, technicals),
      "",
      portfolioBlock,
      "",
      `amount_sol: ${ctx.config.management.deployAmountSol}. bins_below: ${ctx.config.strategy.binsBelow}. bins_above: 0.`,
      `strategy: CHOOSE per candidate (spot | curve | bid_ask). Config default is "${ctx.config.strategy.strategy}" — treat as a hint only. Justify the choice from the candidate's volatility before deploying. Default for meme coins is spot; use bid_ask only with a declared directional thesis.`,
    ].join("\n");
    try {
      const result = await deps.sage.decide({
        systemPrompt: sageSystemPromptWithLessons,
        goal: sageGoal,
        sessionKey: deps.sageSessionKey ?? "meridian-trading",
        cycleId,
        timeoutMs: deps.sageTimeoutMs ?? 90_000,
      });
      const deployed = await detectDeploy();
      if (deployed) {
        const rationale = result.text.trim();
        ctx.logger.info("screening", `sage delegated — deploy landed (cycle=${cycleId})`, {
          rationale: rationale ? rationale.slice(0, 800) : "(empty)",
        });
      } else {
        const topPicks = picked
          .slice(0, 3)
          .map((p) => `${p.pool.name} (score ${p.score.toFixed(0)})`)
          .join(", ");
        const rationale = result.text.trim();
        const reason = [
          `Sage (Hermes agent, memory-backed) reviewed ${picked.length} ranked candidate${picked.length === 1 ? "" : "s"} and declined to deploy.`,
          topPicks ? `Top options offered: ${topPicks}.` : "",
          rationale ? `Sage's rationale: ${rationale}` : "No rationale returned.",
        ]
          .filter(Boolean)
          .join(" ");
        await appendNoDeploy(ctx, {
          summary: `Sage passed on all ${picked.length} candidate${picked.length === 1 ? "" : "s"} this cycle`,
          reason,
          metrics: { scanned, passed, candidates: picked.length, decider: "sage" },
        });
        ctx.logger.info("screening", "sage delegated — no_deploy");
      }
      return { kind: "delegated", picked: picked.length, deployed, text: result.text };
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      // Transport/timeout. If Sage already deployed before dying, do NOT fall back
      // (that would double-deploy). Only log — the deploy is already on the books.
      if (await detectDeploy()) {
        ctx.logger.warn("screening", `sage errored after a deploy landed — NOT falling back (${msg})`);
        return { kind: "delegated", picked: picked.length, deployed: true, text: "(sage errored after deploy)" };
      }
      // Fallback KILLED 2026-08-26 (Sue incident). Sage timing out ≠ authorization to
      // deploy from the local loop, which has zero memory of Sage's prior vetoes and
      // will happily open a token Sage was rejecting. Skip the cycle; next tick tries
      // Sage again. Human can /deploy manually via Telegram if the outage drags on.
      ctx.logger.warn("screening", `sage delegation failed — skipping cycle (fallback disabled): ${msg}`);
      const topPicks = picked
        .slice(0, 3)
        .map((p) => `${p.pool.name} (score ${p.score.toFixed(0)})`)
        .join(", ");
      await appendNoDeploy(ctx, {
        summary: `Sage unreachable — cycle skipped (${picked.length} candidate${picked.length === 1 ? "" : "s"} unreviewed)`,
        reason: [
          `Sage delegation failed (${msg}).`,
          topPicks ? `Candidates deferred to next cycle: ${topPicks}.` : "",
          "Local-loop fallback disabled — a Sage timeout is NOT authorization to deploy without Sage's veto memory.",
        ]
          .filter(Boolean)
          .join(" "),
        metrics: { scanned, passed, candidates: picked.length, decider: "sage", sage_error: msg },
      });
      return { kind: "delegated", picked: picked.length, deployed: false, text: `(sage unreachable: ${msg})` };
    }
  }

  return runLocalLoop();
}
