// Plain-Indonesian rendering of auto lessons and chart snapshots for the Pelajaran page.
//
// An auto lesson's rule reads like
//   "[auto LOSS RARI-SOL -19.4%] AVOID spot when 15m.from_high > -10 AND fee_tvl_ratio < 0.3
//    AND 1h.from_high < -30 — near-top 15m bounce … {applies ONLY when: … — history 0W/1L}"
// The MATCH vocabulary mirrors src/domain/rules/lesson-match.ts — keep field names in sync.

export type Tone = "profit" | "loss" | "neutral";

export interface PlainCondition {
  /** Short plain-language gist, e.g. "Volume sepi". */
  gist: string;
  /** The exact threshold in words, e.g. "volume 1 jam di bawah 0.1× normal". */
  detail: string;
  /** The original machine condition, for the curious. */
  raw: string;
  /** Timeframe-free idea behind the condition, so "15m.from_high > -10" and "1h.from_high > -5"
   *  land on the same node in the lesson web. */
  concept: { key: string; label: string; tf: string | null };
}

export interface PlainLesson {
  action: "ULANGI" | "HINDARI" | null;
  strategy: string | null;
  conditions: PlainCondition[];
  /** The model's English explanation (text after " — "), without the {applies…} suffix. */
  explanation: string | null;
  /** Free-text rule for lessons without a MATCH (manual / older lessons). */
  text: string;
}

const TF: Record<string, string> = { "5m": "5 menit", "15m": "15 menit", "1h": "1 jam", "4h": "4 jam" };

const OP_WORD: Record<string, string> = {
  "<": "di bawah",
  "<=": "maksimal",
  ">": "di atas",
  ">=": "minimal",
  "=": "=",
  "!=": "bukan",
};

const TREND: Record<string, string> = { UP: "NAIK", DOWN: "TURUN", FLAT: "DATAR" };

const fmtNum = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2))));

export function fmtMcap(v: number): string {
  if (Math.abs(v) >= 1e9) return `$${fmtNum(v / 1e9)} M`;
  if (Math.abs(v) >= 1e6) return `$${fmtNum(v / 1e6)} jt`;
  if (Math.abs(v) >= 1e3) return `$${fmtNum(v / 1e3)} rb`;
  return `$${fmtNum(v)}`;
}

interface FieldSpec {
  name: (tf: string) => string;
  fmt?: (v: number) => string;
  /** Gist when the condition caps the value from above (< / <=). */
  low?: (v: number) => string;
  /** Gist when the condition floors the value (> / >=). */
  high?: (v: number) => string;
  /** Value-independent concept label when `low`/`high` vary with the threshold. */
  conceptLow?: string;
  conceptHigh?: string;
}

const pctFmt = (v: number) => `${fmtNum(v)}%`;

const POOL: Record<string, FieldSpec> = {
  fee_tvl_ratio: { name: () => "rasio fee/TVL", low: () => "Fee pool kecil", high: () => "Fee pool besar" },
  volatility: { name: () => "volatilitas pool", low: () => "Pool tenang", high: () => "Pool bergerak liar" },
  organic: { name: () => "skor organik", low: () => "Skor organik rendah", high: () => "Skor organik tinggi" },
  mcap: { name: () => "market cap", fmt: fmtMcap, low: () => "Koin kecil", high: () => "Koin besar" },
  holders: { name: () => "jumlah holder", low: () => "Holder sedikit", high: () => "Holder banyak" },
  bin_step: { name: () => "bin step" },
};

const TECH: Record<string, FieldSpec> = {
  spike: {
    name: (tf) => `lonjakan harga ${tf}`,
    fmt: pctFmt,
    low: (v) => (v <= 0 ? "Harga sedang koreksi" : "Harga belum melonjak"),
    high: (v) => (v >= 50 ? "Harga baru melonjak tajam" : "Harga sedang naik"),
    conceptLow: "Harga tidak sedang melonjak",
    conceptHigh: "Harga sedang melonjak",
  },
  from_high: {
    name: (tf) => `jarak dari puncak ${tf}`,
    fmt: pctFmt,
    low: () => "Sudah jatuh jauh dari puncak",
    high: () => "Masih dekat puncak",
  },
  atr: {
    name: (tf) => `ayunan candle (ATR) ${tf}`,
    fmt: pctFmt,
    low: () => "Ayunan harga sempit",
    high: () => "Ayunan harga lebar",
  },
  vol_x: {
    name: (tf) => `volume ${tf} vs normal`,
    fmt: (v) => `${fmtNum(v)}×`,
    low: () => "Volume sepi",
    high: () => "Volume ramai",
  },
  red_streak: {
    name: (tf) => `candle merah beruntun ${tf}`,
    low: () => "Sedikit candle merah",
    high: () => "Banyak candle merah beruntun",
  },
  support_dist: {
    name: (tf) => `jarak ke support ${tf}`,
    fmt: pctFmt,
    low: () => "Jauh di atas support",
    high: () => "Dekat dengan support",
  },
  support_touches: {
    name: (tf) => `support ${tf} disentuh`,
    fmt: (v) => `${fmtNum(v)}×`,
    low: () => "Support jarang diuji",
    high: () => "Support sudah teruji",
  },
};

const COND_RE = /^\s*([a-z0-9_./]+)\s*(<=|>=|!=|==|=|<|>)\s*(.+?)\s*$/i;

export function plainCondition(raw: string): PlainCondition {
  const m = COND_RE.exec(raw);
  const plainRaw = raw.trim();
  if (!m) return { gist: plainRaw, detail: "", raw: plainRaw, concept: { key: plainRaw, label: plainRaw, tf: null } };
  const field = m[1]!.toLowerCase();
  const op = m[2] === "==" ? "=" : m[2]!;
  const rawVal = m[3]!.replace(/[`"]/g, "").replace(/%$/, "").replace(/^\$/, "").trim();
  const num = Number(rawVal.replace(/^\+/, ""));
  const isNum = rawVal !== "" && Number.isFinite(num);
  const text = rawVal.toUpperCase();
  const cleanRaw = raw.trim();

  if (field === "strategy") {
    const gist = `Strategi ${op === "!=" ? "bukan " : ""}${rawVal.toLowerCase()}`;
    return { gist, detail: "", raw: cleanRaw, concept: { key: `strategy${op}${text}`, label: gist, tf: null } };
  }

  const dot = field.indexOf(".");
  const tfKey = dot >= 0 ? field.slice(0, dot) : "";
  const name = dot >= 0 ? field.slice(dot + 1) : field;
  const tf = TF[tfKey] ?? tfKey;

  if (dot >= 0 && name === "trend") {
    const t = TREND[text] ?? text;
    const not = op === "!=" ? "bukan " : "";
    return {
      gist: `Tren ${tf} ${not}${t}`,
      detail: "",
      raw: cleanRaw,
      concept: { key: `trend${op}${text}`, label: `Tren ${not}${t}`, tf },
    };
  }
  if (dot >= 0 && (name === "at_local_top" || name === "at_local_bottom")) {
    const yes = (text === "YES") !== (op === "!=");
    const where = name === "at_local_top" ? "pucuk" : "dasar";
    const label = `${yes ? "Di" : "Tidak di"} ${where} lokal`;
    return { gist: `Harga ${tf} ${yes ? "" : "tidak "}di ${where} lokal`, detail: "", raw: cleanRaw, concept: { key: `${name}:${yes}`, label, tf } };
  }

  const spec = dot >= 0 ? TECH[name] : POOL[field];
  if (!spec || !isNum) return { gist: cleanRaw, detail: "", raw: cleanRaw, concept: { key: cleanRaw, label: cleanRaw, tf: null } };
  const shown = (spec.fmt ?? fmtNum)(num);
  const isLow = op === "<" || op === "<=";
  const isHigh = op === ">" || op === ">=";
  // Distance fields are negative percentages; "> -10" reads better as "less than 10% below".
  const below = `${fmtNum(Math.abs(num))}%`;
  const detail =
    name === "from_high" && num <= 0 && (isLow || isHigh)
      ? `sudah turun ${isLow ? "lebih" : "kurang"} dari ${below} dari puncak ${tf}`
      : name === "support_dist" && num <= 0 && (isLow || isHigh)
        ? `support ${tf} ${isLow ? "lebih" : "kurang"} dari ${below} di bawah harga`
        : name === "spike" && num === 0 && isLow
          ? `harga ${tf} tidak naik`
          : `${spec.name(tf)} ${OP_WORD[op] ?? op} ${shown}`;
  const base = isLow ? spec.low?.(num) : isHigh ? spec.high?.(num) : undefined;
  // Name the timeframe so "15m.spike < -5 AND 1h.spike < 0" doesn't read as the same thing twice.
  const gist = base ? (tf ? `${base} (${tf})` : base) : capitalize(detail);
  const dir = isLow ? "low" : isHigh ? "high" : `${op}${num}`;
  const conceptLabel = (isLow ? spec.conceptLow : isHigh ? spec.conceptHigh : undefined) ?? base ?? capitalize(detail);
  return { gist, detail, raw: cleanRaw, concept: { key: `${name}:${dir}`, label: conceptLabel, tf: tf || null } };
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "[auto LOSS ZOE-SOL -4.2%] AVOID …" / "[follow:a] PREFER …" → "AVOID …" / "PREFER …". */
export const stripAutoPrefix = (rule: string) => rule.replace(/^\[(?:auto [^\]]*|follow:[^\]]*)\]\s*/, "");

/** Parse a lesson into plain parts. `match` is the lesson's stored MATCH expression, if any. */
export function plainLesson(rule: string, match?: string | null): PlainLesson {
  const body = stripAutoPrefix(rule).replace(/\s*\{applies ONLY when:[^}]*\}\s*$/i, "").trim();
  const head = /^(PREFER|AVOID)\b\s*(spot|curve|bid_ask)?/i.exec(body);
  const action = head ? (head[1]!.toUpperCase() === "PREFER" ? "ULANGI" : "HINDARI") : null;
  const strategy = head?.[2]?.toLowerCase() ?? null;
  const dash = body.indexOf(" — ");
  const explanation = dash >= 0 ? body.slice(dash + 3).trim() || null : null;
  const conditions = match
    ? match
        .split(/\s+AND\s+|\s*&&\s*/i)
        .map((c) => c.trim())
        .filter(Boolean)
        .map(plainCondition)
    : [];
  return { action: conditions.length ? action : null, strategy, conditions, explanation, text: body };
}

// ── Chart snapshot (entry / exit technicals) as plain chips ──

export interface TechLike {
  timeframe: string;
  trend?: "UP" | "DOWN" | "FLAT" | null;
  spike_pct?: number | null;
  at_local_top?: boolean | null;
  atr_pct?: number | null;
  vol_spike?: number | null;
  from_window_high_pct?: number | null;
  support_distance_pct?: number | null;
  consecutive_red_count?: number | null;
}

export interface Chip {
  text: string;
  tone: Tone;
}

export function techChips(t: TechLike): Chip[] {
  const out: Chip[] = [];
  if (t.trend) out.push({ text: `Tren ${TREND[t.trend]}`, tone: t.trend === "UP" ? "profit" : t.trend === "DOWN" ? "loss" : "neutral" });
  if (t.from_window_high_pct != null) {
    const v = t.from_window_high_pct;
    out.push({
      text: v > -3 ? "Di dekat puncak" : `${Math.abs(v).toFixed(0)}% di bawah puncak`,
      tone: v < -30 ? "loss" : "neutral",
    });
  }
  if (t.spike_pct != null && Math.abs(t.spike_pct) >= 5) {
    out.push({ text: `${t.spike_pct > 0 ? "Melonjak" : "Turun"} ${Math.abs(t.spike_pct).toFixed(0)}%`, tone: "neutral" });
  }
  if (t.vol_spike != null) {
    const v = t.vol_spike;
    out.push({
      text: v < 0.5 ? `Volume sepi (${v.toFixed(1)}×)` : v >= 2 ? `Volume ramai (${v.toFixed(1)}×)` : `Volume normal (${v.toFixed(1)}×)`,
      tone: v < 0.5 ? "loss" : v >= 2 ? "profit" : "neutral",
    });
  }
  if (t.atr_pct != null) out.push({ text: `Ayunan ${t.atr_pct.toFixed(0)}%`, tone: "neutral" });
  if (t.support_distance_pct != null) {
    const v = t.support_distance_pct;
    out.push({ text: `Support ${Math.abs(v).toFixed(0)}% di bawah`, tone: v > -5 ? "profit" : v < -20 ? "loss" : "neutral" });
  }
  if (t.at_local_top) out.push({ text: "Di pucuk lokal", tone: "loss" });
  if (t.consecutive_red_count && t.consecutive_red_count >= 2) {
    out.push({ text: `${t.consecutive_red_count} candle merah beruntun`, tone: t.consecutive_red_count >= 4 ? "loss" : "neutral" });
  }
  return out;
}

export const tfLabel = (tf: string) => TF[tf] ?? tf;
