/**
 * Read-only backtest: replay every closed position in lessons.json under each
 * liquidity shape (spot / bid_ask / curve) using GeckoTerminal 5m candles, and
 * compare with what actually happened. Spends nothing and writes nothing but the
 * candle cache and the optional --out report.
 *
 *   npx tsx src/entrypoints/backtest-strategy.ts [--out report.json] [--limit N]
 *       --cache DIR   candle cache (default: <tmp>/meridian-gt-ohlcv)
 *
 * Method + its limits: domain/rules/strategy-sim.ts. Each replay keeps the real
 * entry and exit time — it does not re-run the exit rules under the new shape.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REPLAY_CANDLE_SEC, binOffset, replayRecord } from "../domain/rules/strategy-sim.js";
import type { KlineCandle } from "../domain/schemas/kline.js";
import type { LpStrategy } from "../domain/rules/deploy-planning.js";

const STATE_DIR = process.env.MERIDIAN_STATE_DIR ? path.resolve(process.env.MERIDIAN_STATE_DIR) : process.cwd();
const GT = "https://api.geckoterminal.com/api/v2/networks/solana/pools";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const cacheDir = flag("--cache") ?? path.join(os.tmpdir(), "meridian-gt-ohlcv");
const outPath = flag("--out");
const limit = Number(flag("--limit") ?? Infinity);

interface PerfRecord {
  position: string;
  pool: string;
  pool_name: string;
  pnl_pct: number;
  pnl_usd: number;
  fees_earned_usd: number;
  initial_value_usd: number;
  minutes_held: number;
  close_reason: string;
  amount_sol: number;
  strategy: LpStrategy;
  bin_range?: { min: number; max: number };
  bin_step?: number;
  closed_at: string;
  pnl_source?: string;
  entry_technicals?: Array<Record<string, unknown> & { timeframe: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

/** 5m candles in SOL (currency=token), newest-first from GT; cached per (pool, before). */
async function fetchCandles(pool: string, beforeTs: number): Promise<KlineCandle[] | null> {
  const file = path.join(cacheDir, `${pool}-${beforeTs}.json`);
  try {
    const cached = JSON.parse(await readFile(file, "utf8")) as Array<KlineCandle & Record<string, number>>;
    // Caches written before the KlineCandle switch used {ts, high, low, close, volume}.
    return cached.map((c) => ("ts" in c ? { t: c.ts!, o: c.close!, h: c.high!, l: c.low!, c: c.close!, v: c.volume! } : c));
  } catch {
    /* not cached */
  }
  const url = `${GT}/${pool}/ohlcv/minute?aggregate=5&limit=1000&currency=token&before_timestamp=${beforeTs}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = lastCall + 2500 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(url, { headers: { accept: "application/json" } }).catch(() => null);
    if (!res || res.status === 429 || res.status >= 500) {
      await sleep(10_000 * (attempt + 1));
      continue;
    }
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const candles = (json.data?.attributes?.ohlcv_list ?? []).map(([t, o, h, l, c, v]) => ({
      t: t!, o: o!, h: h!, l: l!, c: c!, v: v!,
    }));
    await writeFile(file, JSON.stringify(candles));
    return candles;
  }
  return null;
}

const pct = (f: number) => `${f >= 0 ? "+" : ""}${(f * 100).toFixed(2)}%`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
};

async function main() {
  await mkdir(cacheDir, { recursive: true });
  const raw = JSON.parse(await readFile(path.join(STATE_DIR, "lessons.json"), "utf8")) as { performance: PerfRecord[] };
  const records = raw.performance.filter((r) => r.bin_range && r.bin_step && r.initial_value_usd > 0).slice(0, limit);
  const strategies: LpStrategy[] = ["spot", "bid_ask", "curve"];
  const rows: Array<Record<string, unknown>> = [];
  const skipped: Array<{ pool_name: string; why: string }> = [];

  for (const r of records) {
    const closeTs = Math.floor(Date.parse(r.closed_at) / 1000);
    const openTs = closeTs - r.minutes_held * 60;
    const candles: KlineCandle[] = [];
    // Page backwards until the deploy is covered (1000 × 5m ≈ 83h per page).
    let before = Math.ceil((closeTs + REPLAY_CANDLE_SEC) / REPLAY_CANDLE_SEC) * REPLAY_CANDLE_SEC;
    for (let page = 0; page < 6; page++) {
      const got = await fetchCandles(r.pool, before);
      if (!got || got.length === 0) break;
      candles.push(...got);
      const oldest = Math.min(...got.map((c) => c.t));
      if (oldest <= openTs - REPLAY_CANDLE_SEC || got.length < 1000) break;
      before = oldest;
    }
    const replayed = replayRecord(
      {
        openTs,
        closeTs,
        binRange: { min: r.bin_range!.min, max: r.bin_range!.max },
        binStep: r.bin_step!,
        actualStrategy: r.strategy,
        actualFeeFrac: r.fees_earned_usd / r.initial_value_usd,
        usdEntryPrice: r.entry_technicals?.find((t) => t.timeframe === "15m")?.last_close as number | undefined,
      },
      candles,
      strategies,
    );
    if (!replayed.ok) {
      skipped.push({ pool_name: r.pool_name, why: replayed.reason });
      continue;
    }
    const { entryPrice, results: replay } = replayed;
    const nBins = r.bin_range!.max - r.bin_range!.min + 1;
    const inWindow = candles.filter((c) => c.t + REPLAY_CANDLE_SEC > openTs && c.t <= closeTs);
    const by = Object.fromEntries(replay.map((x) => [x.strategy, x]));
    const t1h = r.entry_technicals?.find((t) => t.timeframe === "1h");
    const t15 = r.entry_technicals?.find((t) => t.timeframe === "15m");
    rows.push({
      pool_name: r.pool_name,
      position: r.position,
      closed_at: r.closed_at,
      close_reason: r.close_reason,
      minutes_held: r.minutes_held,
      amount_sol: r.amount_sol,
      actual_price_frac: r.pnl_usd / r.initial_value_usd,
      actual_fee_frac: r.fees_earned_usd / r.initial_value_usd,
      actual_net_frac: r.pnl_pct / 100,
      exit_bin_offset: replayed.exitBinOffset,
      max_bin_offset: Math.max(...inWindow.map((c) => binOffset(c.l, entryPrice, r.bin_step!))),
      n_bins: nBins,
      candles: replayed.candles,
      trend_1h: t1h?.trend ?? null,
      atr_1h: t1h?.atr_pct ?? null,
      atr_15m: t15?.atr_pct ?? null,
      from_high_1h: t1h?.from_window_high_pct ?? null,
      support_dist_1h: t1h?.support_distance_pct ?? null,
      sim: by,
    });
    const s = by.spot!, b = by.bid_ask!;
    console.log(
      `${r.pool_name.padEnd(16)} ${String(r.close_reason).padEnd(12)} actual ${pct(r.pnl_pct / 100).padStart(8)} | ` +
        `sim spot ${pct(s.netFrac).padStart(8)} (px ${pct(s.priceFrac)}) | bid_ask ${pct(b.netFrac).padStart(8)} ` +
        `(px ${pct(b.priceFrac)}, fee×${b.feeRatio.toFixed(2)}) | exit bin ${(rows.at(-1)!.exit_bin_offset as number).toFixed(1)}`,
    );
  }

  const net = (s: string) => rows.map((x) => (x.sim as Record<string, { netFrac: number }>)[s]!.netFrac);
  const solPnl = (s: string) =>
    rows.reduce((a, x) => a + (x.sim as Record<string, { netFrac: number }>)[s]!.netFrac * (x.amount_sol as number), 0);
  const summary = {
    replayed: rows.length,
    skipped,
    actual: {
      mean: rows.reduce((a, x) => a + (x.actual_net_frac as number), 0) / rows.length,
      median: median(rows.map((x) => x.actual_net_frac as number)),
      wins: rows.filter((x) => (x.actual_net_frac as number) > 0).length,
      sol: rows.reduce((a, x) => a + (x.actual_net_frac as number) * (x.amount_sol as number), 0),
    },
    ...Object.fromEntries(
      strategies.map((s) => [
        s,
        {
          mean: net(s).reduce((a, b) => a + b, 0) / rows.length,
          median: median(net(s)),
          wins: net(s).filter((v) => v > 0).length,
          worst: Math.min(...net(s)),
          sol: solPnl(s),
        },
      ]),
    ),
    // Simulator sanity: how close is the replayed spot price-leg to what really happened?
    spot_price_leg_mae: rows.reduce(
      (a, x) => a + Math.abs((x.sim as Record<string, { priceFrac: number }>).spot!.priceFrac - (x.actual_price_frac as number)),
      0,
    ) / rows.length,
  };
  console.log("\n" + JSON.stringify(summary, null, 2));
  if (outPath) await writeFile(outPath, JSON.stringify({ summary, rows }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
