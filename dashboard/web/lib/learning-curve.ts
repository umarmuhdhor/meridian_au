// Learning-curve series for the Pelajaran page: per closed position, in close order, the
// rolling win rate, the running net $ and the running count of rules the close review wrote.
// Positions closed before the first review form the "before learning" baseline.

export interface CurveInput {
  pool_name?: string | null;
  pool?: string;
  pnl_pct: number;
  pnl_usd?: number;
  fees_earned_usd?: number;
  closed_at?: string | null;
  recorded_at?: string;
  review?: { outcome: "win" | "loss"; net_usd?: number | null; lesson_id?: string | null } | null;
}

export interface CurvePoint {
  i: number;
  coin: string;
  when: string | null;
  pnl: number;
  net: number;
  win: boolean;
  /** Win rate (%) over the last `window` closes (fewer at the start). */
  winRate: number;
  cumNet: number;
  rulesRepeat: number;
  rulesAvoid: number;
  /** The rule this close produced, if any. */
  learned: "ULANGI" | "HINDARI" | null;
}

export interface PhaseStats {
  n: number;
  winRate: number;
  avgNet: number;
  /** Mean net $ of the losing closes (≤ 0), 0 when none. */
  avgLoss: number;
  /** Mean net $ of the winning closes, 0 when none. */
  avgWin: number;
}

export interface LearningCurve {
  points: CurvePoint[];
  /** 1-based index of the first reviewed close, or null if nothing was reviewed yet. */
  startIndex: number | null;
  before: PhaseStats | null;
  after: PhaseStats | null;
}

export const netUsd = (p: CurveInput): number =>
  p.review?.net_usd ?? (p.pnl_usd ?? 0) + (p.fees_earned_usd ?? 0);

const isWin = (p: CurveInput) => (p.review ? p.review.outcome === "win" : p.pnl_pct > 0);

function phase(rows: CurveInput[]): PhaseStats | null {
  if (!rows.length) return null;
  const nets = rows.map(netUsd);
  const wins = rows.filter(isWin);
  const winNets = rows.filter(isWin).map(netUsd);
  const lossNets = rows.filter((p) => !isWin(p)).map(netUsd);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  return {
    n: rows.length,
    winRate: (wins.length / rows.length) * 100,
    avgNet: mean(nets),
    avgWin: mean(winNets),
    avgLoss: mean(lossNets),
  };
}

export function learningCurve(performance: readonly CurveInput[], window = 10): LearningCurve {
  const rows = [...performance].sort(
    (a, b) => Date.parse(String(a.closed_at ?? a.recorded_at)) - Date.parse(String(b.closed_at ?? b.recorded_at))
  );
  let cumNet = 0;
  let rulesRepeat = 0;
  let rulesAvoid = 0;
  const points = rows.map((p, idx): CurvePoint => {
    const net = netUsd(p);
    cumNet += net;
    const win = isWin(p);
    let learned: CurvePoint["learned"] = null;
    if (p.review?.lesson_id) {
      learned = p.review.outcome === "win" ? "ULANGI" : "HINDARI";
      if (learned === "ULANGI") rulesRepeat += 1;
      else rulesAvoid += 1;
    }
    const recent = rows.slice(Math.max(0, idx + 1 - window), idx + 1);
    return {
      i: idx + 1,
      coin: p.pool_name ?? p.pool?.slice(0, 8) ?? "?",
      when: p.closed_at ?? p.recorded_at ?? null,
      pnl: Number.isFinite(p.pnl_pct) ? p.pnl_pct : 0,
      net,
      win,
      winRate: (recent.filter(isWin).length / recent.length) * 100,
      cumNet,
      rulesRepeat,
      rulesAvoid,
      learned,
    };
  });
  const first = rows.findIndex((p) => p.review);
  return {
    points,
    startIndex: first >= 0 ? first + 1 : null,
    before: first >= 0 ? phase(rows.slice(0, first)) : phase(rows),
    after: first >= 0 ? phase(rows.slice(first)) : null,
  };
}
