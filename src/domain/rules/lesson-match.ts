import type { Lesson, PerformanceRecord } from "../schemas/lesson.js";
import type { TechnicalsSummary } from "../schemas/kline.js";

/**
 * Machine-checkable lesson conditions.
 *
 * An auto lesson used to be free text ("AVOID spot when fee_tvl_ratio < 1.0"). Backtested
 * against the trade history, every such single-factor rule blocked MORE winners than
 * losers (fee_tvl_ratio < 1.0 → 27W/14L, 1h from_high < -30% → 13W/8L) — the bot was
 * learning to skip good coins. Now every auto lesson must carry a MATCH expression in the
 * screener's own vocabulary, which is evaluated against past entries before the lesson is
 * accepted: an AVOID rule may not match past winners, a PREFER rule may not match past
 * losers.
 *
 * Syntax: 2–4 conditions joined by AND, e.g.
 *   1h.from_high < -32 AND 1h.trend = DOWN AND fee_tvl_ratio < 0.3
 * Fields mirror the candidate line + `technicals:` block the screener reads.
 */

export const MIN_CONDITIONS = 2;
export const MAX_CONDITIONS = 4;

type Op = "<" | "<=" | ">" | ">=" | "=" | "!=";

export interface MatchCondition {
  field: string;
  op: Op;
  value: number | string;
}

const POOL_FIELDS: Record<string, (p: PerformanceRecord) => number | string | null | undefined> = {
  fee_tvl_ratio: (p) => p.fee_tvl_ratio,
  volatility: (p) => p.volatility,
  organic: (p) => p.organic_score,
  mcap: (p) => p.entry_mcap,
  holders: (p) => p.holders_at_entry,
  bin_step: (p) => p.bin_step,
  strategy: (p) => p.strategy,
};

const yesNo = (b: boolean | null | undefined) => (b == null ? null : b ? "YES" : "NO");

const TECH_FIELDS: Record<string, (t: TechnicalsSummary) => number | string | null | undefined> = {
  trend: (t) => t.trend,
  spike: (t) => t.spike_pct,
  from_high: (t) => t.from_window_high_pct,
  atr: (t) => t.atr_pct,
  vol_x: (t) => t.vol_spike,
  red_streak: (t) => t.consecutive_red_count,
  support_dist: (t) => t.support_distance_pct,
  support_touches: (t) => t.support_touches,
  at_local_top: (t) => yesNo(t.at_local_top),
  at_local_bottom: (t) => yesNo(t.at_local_bottom),
};

const TIMEFRAMES = ["5m", "15m", "1h", "4h"];

export const MATCH_FIELD_HELP =
  `pool: ${Object.keys(POOL_FIELDS).join(", ")}; per timeframe (${TIMEFRAMES.slice(1, 3).join(", ")}): ` +
  `<tf>.${Object.keys(TECH_FIELDS).join(", <tf>.")}. Percent fields are plain numbers (from_high=-34.8% → -34.8).`;

function fieldValue(p: PerformanceRecord, field: string): number | string | null | undefined {
  const dot = field.indexOf(".");
  if (dot < 0) return POOL_FIELDS[field]?.(p);
  const tf = field.slice(0, dot);
  const name = field.slice(dot + 1);
  const t = p.entry_technicals?.find((x) => x.timeframe === tf);
  return t ? TECH_FIELDS[name]?.(t) : undefined;
}

function isKnownField(field: string): boolean {
  const dot = field.indexOf(".");
  if (dot < 0) return field in POOL_FIELDS;
  return TIMEFRAMES.includes(field.slice(0, dot)) && field.slice(dot + 1) in TECH_FIELDS;
}

const COND_RE = /^\s*([a-z0-9_.]+)\s*(<=|>=|!=|==|=|<|>)\s*(.+?)\s*$/i;

/** Parse a MATCH expression. Returns an error string instead of throwing. */
export function parseMatch(expr: string): { ok: true; value: MatchCondition[] } | { ok: false; error: string } {
  const text = expr.trim().replace(/[`"]/g, "");
  if (!text) return { ok: false, error: "empty MATCH" };
  if (/\bOR\b/i.test(text)) return { ok: false, error: "OR is not allowed — use AND only" };
  const parts = text.split(/\s+AND\s+|\s*&&\s*/i);
  if (parts.length < MIN_CONDITIONS) return { ok: false, error: `needs at least ${MIN_CONDITIONS} conditions joined by AND` };
  if (parts.length > MAX_CONDITIONS) return { ok: false, error: `at most ${MAX_CONDITIONS} conditions` };
  const out: MatchCondition[] = [];
  for (const part of parts) {
    const m = COND_RE.exec(part);
    if (!m) return { ok: false, error: `cannot parse condition "${part}"` };
    const field = m[1]!.toLowerCase();
    if (!isKnownField(field)) return { ok: false, error: `unknown field "${m[1]}"` };
    const op = (m[2] === "==" ? "=" : m[2]) as Op;
    const raw = m[3]!.replace(/%$/, "").replace(/^\$/, "").trim();
    const num = Number(raw.replace(/^\+/, ""));
    const value = raw !== "" && Number.isFinite(num) ? num : raw.toUpperCase();
    if (typeof value === "string" && op !== "=" && op !== "!=") {
      return { ok: false, error: `"${part}" compares text with ${op}` };
    }
    out.push({ field, op, value });
  }
  return { ok: true, value: out };
}

function test(actual: number | string | null | undefined, op: Op, value: number | string): boolean {
  if (actual == null) return false; // unknown at entry → the condition does not hold
  if (typeof value === "string") {
    const a = String(actual).toUpperCase();
    return op === "=" ? a === value : a !== value;
  }
  if (typeof actual !== "number" || !Number.isFinite(actual)) return false;
  switch (op) {
    case "<": return actual < value;
    case "<=": return actual <= value;
    case ">": return actual > value;
    case ">=": return actual >= value;
    case "=": return actual === value;
    case "!=": return actual !== value;
  }
}

export function matchesRecord(conds: readonly MatchCondition[], p: PerformanceRecord): boolean {
  return conds.every((c) => test(fieldValue(p, c.field), c.op, c.value));
}

export function formatMatch(conds: readonly MatchCondition[]): string {
  return conds.map((c) => `${c.field} ${c.op} ${c.value}`).join(" AND ");
}

export interface MatchBacktest {
  wins: number;
  losses: number;
  winners: string[];
  losers: string[];
}

const label = (p: PerformanceRecord) => `${p.pool_name ?? p.pool?.slice(0, 8) ?? "?"} ${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(1)}%`;

export function backtestMatch(conds: readonly MatchCondition[], history: readonly PerformanceRecord[]): MatchBacktest {
  const hit = history.filter((p) => matchesRecord(conds, p));
  const w = hit.filter((p) => p.pnl_pct > 0);
  const l = hit.filter((p) => p.pnl_pct <= 0);
  return { wins: w.length, losses: l.length, winners: w.map(label), losers: l.map(label) };
}

/**
 * Is the rule specific enough to keep? An AVOID rule (from a loss) may hit no past winner,
 * or a single one when it also catches at least three losers; a PREFER rule (from a win)
 * mirrors that against losers. Below that, the rule would cost more good trades than it saves.
 */
export function acceptBacktest(outcome: "win" | "loss", bt: MatchBacktest): boolean {
  const against = outcome === "loss" ? bt.wins : bt.losses;
  const forIt = outcome === "loss" ? bt.losses : bt.wins;
  return against === 0 ? forIt >= 1 : against === 1 && forIt >= 3;
}

/**
 * Pure — is this MATCH an acceptable lesson? It must parse, match this trade's own entry,
 * and, backtested over `history` (this trade included), not catch past trades of the
 * opposite outcome (see `acceptBacktest`).
 */
export function checkMatch(
  match: string | null,
  perf: PerformanceRecord,
  outcome: "win" | "loss",
  history: readonly PerformanceRecord[],
): { ok: true; match: string; backtest: MatchBacktest } | { ok: false; reason: string } {
  if (!match) return { ok: false, reason: "no MATCH line — every lesson needs a checkable MATCH" };
  const parsed = parseMatch(match);
  if (!parsed.ok) return { ok: false, reason: `MATCH invalid: ${parsed.error}` };
  const conds = parsed.value;
  if (!matchesRecord(conds, perf)) {
    return { ok: false, reason: `MATCH does not match this trade's own entry (${describeEntry(perf)})` };
  }
  const withSelf = history.some((p) => p.position === perf.position) ? history : [...history, perf];
  const bt = backtestMatch(conds, withSelf);
  if (!acceptBacktest(outcome, bt)) {
    const wrong = outcome === "loss" ? bt.winners : bt.losers;
    const kind = outcome === "loss" ? "WINNING" : "LOSING";
    return {
      ok: false,
      reason: `too broad — in history it matches ${bt.wins}W/${bt.losses}L, including ${wrong.length} ${kind} trade(s): ${wrong.slice(0, 8).join(", ")}`,
    };
  }
  return { ok: true, match: formatMatch(conds), backtest: bt };
}

/** What the screener sees about a candidate at entry time, in PerformanceRecord shape. */
export interface CandidateEntry {
  fee_tvl_ratio?: number | null;
  volatility?: number | null;
  organic_score?: number | null;
  mcap?: number | null;
  holders?: number | null;
  bin_step?: number | null;
  technicals?: readonly TechnicalsSummary[] | null;
}

export function candidateAsRecord(c: CandidateEntry): PerformanceRecord {
  return {
    position: "candidate",
    pnl_pct: 0,
    close_reason: "",
    fee_tvl_ratio: c.fee_tvl_ratio ?? null,
    volatility: c.volatility ?? null,
    organic_score: c.organic_score ?? null,
    entry_mcap: c.mcap ?? null,
    holders_at_entry: c.holders ?? null,
    bin_step: c.bin_step ?? null,
    entry_technicals: [...(c.technicals ?? [])],
  } as PerformanceRecord;
}

export interface LessonHit {
  lesson: Lesson;
  /** Set when the lesson's MATCH also names a strategy — it applies only if that strategy is chosen. */
  strategy: string | null;
}

/**
 * The MATCH-bearing lessons whose condition holds for this candidate. `strategy` isn't
 * known before the decision, so a strategy condition is not evaluated here; it is
 * returned so the screener can see "applies if you pick spot".
 */
export function lessonsForCandidate(lessons: readonly Lesson[], candidate: PerformanceRecord): LessonHit[] {
  const hits: LessonHit[] = [];
  for (const lesson of lessons) {
    if (!lesson.match) continue;
    const parsed = parseMatch(lesson.match);
    if (!parsed.ok) continue;
    const strategyCond = parsed.value.find((c) => c.field === "strategy");
    const rest = parsed.value.filter((c) => c.field !== "strategy");
    if (rest.length === 0 || !matchesRecord(rest, candidate)) continue;
    hits.push({ lesson, strategy: strategyCond && strategyCond.op === "=" ? String(strategyCond.value).toLowerCase() : null });
  }
  return hits;
}

/** Prompt rules shared by every reviewer that writes MATCH-checked lessons. */
export const MATCH_PROMPT_RULES: readonly string[] = [
  "SPECIFICITY IS THE WHOLE POINT. The bot wins about two trades in three, so a broad AVOID rule mostly blocks",
  "future WINNERS (and a broad PREFER rule pushes it into losers). Measured on this bot's history, single-factor",
  "rules blocked more winners than losers: fee_tvl_ratio < 1.0 (27W/14L), 1h.from_high < -30 (13W/8L),",
  "1h.trend = DOWN (16W/8L). So:",
  "  - Combine 2-4 conditions with AND, each with a threshold close to THIS trade's own entry value.",
  "  - Your MATCH must match THIS trade and none of the OPPOSITE-OUTCOME trades listed below (they looked",
  "    similar at entry but ended the other way). Pick the conditions that separate this trade from them.",
  "  - MATCH is backtested against the full history before the lesson is kept; one that catches past",
  "    opposite-outcome trades is rejected.",
  "  - If nothing visible at entry separates this trade from those, answer LESSON: NONE and MATCH: NONE.",
  "  - Only answer NONE as a duplicate if an existing lesson has essentially the same specific conditions.",
  "",
  `MATCH fields — ${MATCH_FIELD_HELP}`,
  "Operators: < <= > >= = !=. Text values: trend UP/DOWN/FLAT, at_local_top YES/NO, strategy spot/bid_ask.",
];

/** Prompt block: this trade's entry + the lookalike trades that ended the other way. */
export function formatMatchContext(p: PerformanceRecord, history: readonly PerformanceRecord[]): string[] {
  const lines = ["ENTRY (this trade, in MATCH vocabulary — your MATCH must be true for it):", `  ${describeEntry(p)}`];
  const opposite = similarOpposite(p, history);
  if (opposite.length) {
    lines.push("");
    lines.push(
      `OPPOSITE-OUTCOME TRADES (${p.pnl_pct > 0 ? "LOSERS" : "WINNERS"} whose entry looked most like this one — your MATCH must be FALSE for each):`,
    );
    for (const o of opposite) {
      lines.push(`  ${o.pool_name ?? "?"} ${o.pnl_pct >= 0 ? "+" : ""}${o.pnl_pct.toFixed(1)}%: ${describeEntry(o)}`);
    }
  }
  return lines;
}

/** One entry in MATCH vocabulary — what the reviewer sees for this and similar trades. */
export function describeEntry(p: PerformanceRecord): string {
  const parts: string[] = [];
  for (const [k, get] of Object.entries(POOL_FIELDS)) {
    const v = get(p);
    if (v == null) continue;
    parts.push(`${k}=${typeof v === "number" ? +v.toFixed(k === "fee_tvl_ratio" ? 3 : 2) : v}`);
  }
  for (const t of p.entry_technicals ?? []) {
    if (!TIMEFRAMES.includes(t.timeframe) || t.candles === 0) continue;
    for (const [k, get] of Object.entries(TECH_FIELDS)) {
      const v = get(t);
      if (v == null) continue;
      parts.push(`${t.timeframe}.${k}=${typeof v === "number" ? +v.toFixed(1) : v}`);
    }
  }
  return parts.join(" ");
}

function features(p: PerformanceRecord): number[] | null {
  const h = p.entry_technicals?.find((t) => t.timeframe === "1h");
  const m = p.entry_technicals?.find((t) => t.timeframe === "15m");
  if (!h && !m) return null;
  const trend = (t?: TechnicalsSummary) => (t?.trend === "UP" ? 1 : t?.trend === "DOWN" ? -1 : 0);
  return [
    Math.log10(Math.max(p.fee_tvl_ratio ?? 0.01, 0.01)) * 2,
    (h?.from_window_high_pct ?? 0) / 10,
    Math.sign(h?.spike_pct ?? 0) * Math.log10(1 + Math.abs(h?.spike_pct ?? 0)),
    (h?.atr_pct ?? 0) / 10,
    trend(h) * 1.5,
    trend(m),
    (m?.from_window_high_pct ?? 0) / 10,
  ];
}

/**
 * The past trades with the OPPOSITE outcome whose entry looked most like this one — the
 * trades a careless rule would wrongly catch. Shown to the reviewer up front.
 */
export function similarOpposite(
  p: PerformanceRecord,
  history: readonly PerformanceRecord[],
  n = 10,
): PerformanceRecord[] {
  const f = features(p);
  if (!f) return [];
  const wantWin = !(p.pnl_pct > 0);
  return history
    .filter((x) => x.position !== p.position && x.pnl_pct > 0 === wantWin)
    .map((x) => ({ x, fx: features(x) }))
    .filter((r): r is { x: PerformanceRecord; fx: number[] } => r.fx != null)
    .map(({ x, fx }) => ({ x, d: fx.reduce((s, v, i) => s + (v - f[i]!) ** 2, 0) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((r) => r.x);
}
