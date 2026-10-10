import type { ChainClient } from "../../ports/chain-client.js";
import type { LessonRepo } from "../../ports/lesson-repo.js";
import type { Logger } from "../../ports/logger.js";
import type { PerformanceRecord } from "../../domain/schemas/lesson.js";

/** A footer must never hold a notification hostage — past this it is dropped. */
const FOOTER_TIMEOUT_MS = 4_000;

export interface WalletFooterInput {
  wallet_sol: number;
  sol_price: number;
  /** SOL value of every open position (liquidity + unclaimed fees); null when unreadable. */
  positions_sol: number | null;
  open_positions: number;
  performance: PerformanceRecord[];
}

/**
 * Realized result of one closed position, in SOL. `pnl_pct` is net of fees against the
 * deposit, so `amount_sol × pnl_pct` is the SOL actually gained/lost. Records without
 * `amount_sol` fall back to the USD figures at today's SOL price.
 */
export function realizedPnlSol(r: PerformanceRecord, solPrice: number): number | null {
  if (r.amount_sol != null && r.amount_sol > 0) return (r.amount_sol * r.pnl_pct) / 100;
  if (r.pnl_usd != null && solPrice > 0) return (r.pnl_usd + (r.fees_earned_usd ?? 0)) / solPrice;
  return null;
}

function fmt(n: number): string {
  return Number(n.toFixed(4)).toString();
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : "-"}${fmt(Math.abs(n))}`;
}

/**
 * Plain text (no HTML tags, no `<>&`), so it is safe to append to both the plain and
 * the HTML-parse-mode Telegram sends.
 */
export function formatWalletFooter(i: WalletFooterInput): string {
  const total = i.wallet_sol + (i.positions_sol ?? 0);
  const breakdown =
    i.positions_sol != null && i.open_positions > 0
      ? ` (dompet ${fmt(i.wallet_sol)} + ${i.open_positions} posisi ${fmt(i.positions_sol)})`
      : i.positions_sol == null
        ? " (dompet saja, nilai posisi tidak terbaca)"
        : "";
  const totalUsd = i.sol_price > 0 ? ` ≈ $${(total * i.sol_price).toFixed(2)}` : "";

  let lossSol = 0;
  let lossCount = 0;
  let netSol = 0;
  for (const r of i.performance) {
    const pnl = realizedPnlSol(r, i.sol_price);
    if (pnl == null) continue;
    netSol += pnl;
    if (pnl < 0) {
      lossSol += pnl;
      lossCount += 1;
    }
  }

  return [
    "━━━━━━━━━━━━━━━",
    `💼 Sisa saldo: ${fmt(total)} SOL${totalUsd}${breakdown}`,
    `📉 Total rugi: ${signed(lossSol)} SOL (${lossCount} posisi rugi) · Net: ${signed(netSol)} SOL`,
  ].join("\n");
}

export interface WalletFooterDeps {
  chain: ChainClient;
  lessons: LessonRepo;
  logger: Logger;
  timeoutMs?: number;
}

/**
 * Builds the balance + total-loss footer appended to every Telegram message. Resolves
 * null on any failure or timeout so the message still goes out without it.
 */
export function createWalletFooter(deps: WalletFooterDeps): () => Promise<string | null> {
  const timeoutMs = deps.timeoutMs ?? FOOTER_TIMEOUT_MS;

  async function build(): Promise<string | null> {
    const [wallet, performance, positions] = await Promise.all([
      deps.chain.getWalletBalance(),
      deps.lessons.recentPerformance(Number.MAX_SAFE_INTEGER),
      // Cached read (no force) — a footer is not worth an extra RPC round-trip per message.
      deps.chain.getMyPositions().catch(() => null),
    ]);
    let positionsSol: number | null = null;
    if (positions && wallet.sol_price > 0) {
      const usd = positions.positions.reduce(
        (s, p) => s + (p.total_value_usd ?? 0) + (p.unclaimed_fees_usd ?? 0),
        0,
      );
      positionsSol = usd / wallet.sol_price;
    }
    return formatWalletFooter({
      wallet_sol: wallet.sol,
      sol_price: wallet.sol_price,
      positions_sol: positionsSol,
      open_positions: positions?.positions.length ?? 0,
      performance,
    });
  }

  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        build(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
    } catch (err) {
      deps.logger.warn("telegram", "wallet footer failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
