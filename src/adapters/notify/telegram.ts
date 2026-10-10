import type {
  ClaimResult,
  CloseResult,
  DeployResult,
  SwapResult,
} from "../../domain/schemas/chain.js";
import type { Logger } from "../../ports/logger.js";
import {
  activeBinPosition,
  binRangeToPricePct,
} from "../../domain/format/decision-strings.js";
import type {
  LiveMessageHandle,
  Notifier,
  NotifyKind,
} from "../../ports/notifier.js";

const DEFAULT_BASE_URL = "https://api.telegram.org";
const TELEGRAM_MAX_MESSAGE = 4096;
const DEFAULT_TIMEOUT_MS = 8_000;

/** Deep link to the pool on Meteora (Telegram auto-links the bare URL). */
const meteoraPoolUrl = (pool: string): string =>
  `https://www.meteora.ag/dlmm/${pool}?referrer=portfolio`;

export type FetchImpl = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface TelegramNotifierOptions {
  botToken: string;
  chatId: string;
  logger: Logger;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Appended under every message (balance + total loss). Plain text, safe in HTML mode.
   * Resolving null — or throwing — sends the message without it.
   */
  footer?: () => Promise<string | null>;
}

interface SendMessageResult {
  message_id: number;
}

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

function truncate(text: string, max = TELEGRAM_MAX_MESSAGE): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 30)}\n… (truncated)`;
}

/** Truncates the body, never the footer — the footer is the part the reader wants. */
function attachFooter(body: string, footer: string | null): string {
  if (!footer) return truncate(body);
  return `${truncate(body, TELEGRAM_MAX_MESSAGE - footer.length - 2)}\n\n${footer}`;
}

function kindPrefix(kind: NotifyKind): string {
  switch (kind) {
    case "info":
      return "ℹ️";
    case "warn":
      return "⚠️";
    case "error":
      return "❌";
    case "success":
      return "✅";
  }
}

interface LiveState {
  messageId: number;
  header: string;
  lines: string[];
  footer: string | null;
  finalized: boolean;
}

/**
 * Real Telegram notifier — outbound only.
 *
 * Long-poll REPL / inbound command handling is a separate app-layer concern (deferred
 * to the Telegram bridge phase). This adapter satisfies the `Notifier` port so the
 * daemon can push deploy/close/claim/swap/OOR events and drive the in-place live
 * message the JS `createLiveMessage` provides.
 *
 * Live messages: each `startLive` sends one initial message and returns a handle
 * whose `toolStart` / `toolFinish` / `note` / `finalize` calls edit that message
 * in place (`editMessageText`). Editing avoids the notification spam that a
 * per-tool-call message would produce.
 */
export function createTelegramNotifier(opts: TelegramNotifierOptions): Notifier {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  if (typeof fetchImpl !== "function") {
    throw new Error("createTelegramNotifier: no fetch implementation available");
  }
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function getFooter(): Promise<string | null> {
    if (!opts.footer) return null;
    try {
      return await opts.footer();
    } catch {
      return null;
    }
  }

  async function post<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${baseUrl}/bot${opts.botToken}/${method}`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw: unknown = await res.json().catch(() => null);
      const env = raw as TelegramApiEnvelope<T> | null;
      if (!res.ok || !env?.ok) {
        opts.logger.warn("telegram", `${method} failed`, {
          status: res.status,
          description: env?.description,
        });
        return null;
      }
      return env.result ?? null;
    } catch (err) {
      opts.logger.warn("telegram", `${method} threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendMessage(text: string, footer: string | null): Promise<SendMessageResult | null> {
    return post<SendMessageResult>("sendMessage", {
      chat_id: opts.chatId,
      text: attachFooter(text, footer),
      disable_web_page_preview: true,
    });
  }

  /** Event cards: HTML parse mode for bold + tappable links. Every interpolated
   *  string must go through `esc` — a `<` in a pool name would fail the send. */
  async function sendHtml(text: string): Promise<void> {
    const footer = await getFooter();
    const room = TELEGRAM_MAX_MESSAGE - (footer ? footer.length + 2 : 0);
    const body = text.length <= room ? text : `${text.slice(0, room - 30)}…`;
    await post<SendMessageResult>("sendMessage", {
      chat_id: opts.chatId,
      text: footer ? `${body}\n\n${footer}` : body,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }

  async function editMessage(messageId: number, text: string): Promise<void> {
    await post("editMessageText", {
      chat_id: opts.chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
    });
  }

  function renderLive(state: LiveState): string {
    return attachFooter([state.header, "", ...state.lines].join("\n"), state.footer);
  }

  async function startLive(header: string): Promise<LiveMessageHandle> {
    // Read once: re-fetching the balance on every tool-line edit is pointless churn.
    const footer = await getFooter();
    const sent = await sendMessage(header, footer);
    const state: LiveState = {
      messageId: sent?.message_id ?? 0,
      header,
      lines: [],
      footer,
      finalized: false,
    };
    async function push(): Promise<void> {
      if (state.finalized || !state.messageId) return;
      await editMessage(state.messageId, renderLive(state));
    }
    return {
      async toolStart(name: string, args?: Record<string, unknown>) {
        const argSummary = args ? summarizeArgs(args) : "";
        state.lines.push(`⏳ ${name}${argSummary ? ` ${argSummary}` : ""}`);
        await push();
      },
      async toolFinish(name: string, ok: boolean, summary?: string) {
        const icon = ok ? "✅" : "❌";
        // Replace the last matching ⏳ line (in reverse) for the same tool name.
        for (let i = state.lines.length - 1; i >= 0; i -= 1) {
          const line = state.lines[i]!;
          if (line.startsWith(`⏳ ${name}`)) {
            state.lines[i] = `${icon} ${name}${summary ? ` — ${summary}` : ""}`;
            break;
          }
        }
        await push();
      },
      async note(text: string) {
        state.lines.push(`· ${text}`);
        await push();
      },
      async finalize(text?: string) {
        if (text) state.lines.push("", text);
        await push();
        state.finalized = true;
      },
      async fail(reason: string) {
        state.lines.push("", `❌ ${reason}`);
        await push();
        state.finalized = true;
      },
    };
  }

  return {
    async notify(kind, text) {
      await sendMessage(`${kindPrefix(kind)} ${text}`, await getFooter());
    },
    async notifyDeploy(r: DeployResult) {
      await sendHtml(formatDeployCard(r));
    },
    async notifyClose(r: CloseResult) {
      await sendHtml(formatCloseCard(r));
    },
    async notifyClaim(r: ClaimResult) {
      const sol = r.claimed_sol != null ? ` (${fmtSol(r.claimed_sol)} SOL)` : "";
      await sendHtml(
        [
          `💰 <b>KLAIM FEE</b>${dryTag(r.dry_run)}`,
          DIVIDER,
          `💵 Diklaim: <b>${fmtDollar(r.claimed_usd)}</b>${sol}`,
          DIVIDER,
          linkRow([
            ["Posisi", solscanAccountUrl(r.position_address)],
            ["Tx", txUrl(r.tx, r.dry_run)],
          ]),
        ].join("\n"),
      );
    },
    // Not posted: every close triggers an auto-swap (plus the dust sweeper), and the
    // card only repeated what the close card already said. Logged instead.
    async notifySwap(r: SwapResult) {
      opts.logger.info("telegram", "swap not posted", {
        input_mint: r.input_mint,
        output_mint: r.output_mint,
        amount_in: r.amount_in,
        amount_out: r.amount_out,
        tx: r.tx,
      });
    },
    async notifyOutOfRange(position, minutes) {
      await sendMessage(`⚠️ OOR — ${position.slice(0, 8)}… for ${minutes} min`, await getFooter());
    },
    startLive,
  };
}

// Adaptive precision — small numbers (< $1 or < 1%) show more decimals so
// $0.0031 doesn't render as "$0.00" and 0.03% doesn't collapse to "0.00%".
function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs === 0) return "0.00";
  if (abs < 0.01) return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (abs < 1) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return n.toFixed(2);
}
function fmtDollar(n: number): string {
  return n < 0 ? `-$${fmtUsd(-n)}` : `$${fmtUsd(n)}`;
}
function fmtPct(n: number): string {
  const abs = Math.abs(n);
  if (abs === 0) return "0.00";
  if (abs < 0.01) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return n.toFixed(2);
}

function fmtSol(n: number): string {
  return Number(n.toFixed(4)).toString();
}

function signedPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${fmtPct(n)}%`;
}

/** Indonesian, for the group's readers: "45 mnt", "2 jam 15 mnt", "1 hari 3 jam". */
function humanDuration(minutes: number): string {
  if (minutes < 1) return "<1 mnt";
  if (minutes < 60) return `${minutes} mnt`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m > 0 ? `${h} jam ${m} mnt` : `${h} jam`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d} hari ${rh} jam` : `${d} hari`;
}

// ── event cards (HTML) ───────────────────────────────────────────────────────

const DIVIDER = "━━━━━━━━━━━━━━━";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function dryTag(dry: boolean): string {
  return dry ? " <i>[DRY]</i>" : "";
}

function solscanAccountUrl(address: string): string {
  return `https://solscan.io/account/${address}`;
}

/** Null for dry-run / missing signatures — those are not real transactions. */
function txUrl(tx: string | null, dry: boolean): string | null {
  return tx && !dry ? `https://solscan.io/tx/${tx}` : null;
}

function linkRow(links: Array<[label: string, url: string | null]>): string {
  const parts = links
    .filter((l): l is [string, string] => l[1] != null)
    .map(([label, url]) => `<a href="${esc(url)}">${esc(label)}</a>`);
  return parts.length ? `🔗 ${parts.join(" · ")}` : "";
}

const STRATEGY_LABEL: Record<string, string> = {
  spot: "Spot (merata di seluruh range)",
  curve: "Curve (terpusat di harga aktif)",
  bid_ask: "Bid-Ask (tebal di tepi range)",
};

const PRICE_POSITION_LABEL: Record<ReturnType<typeof activeBinPosition>, string> = {
  "at the top edge": "di tepi atas range",
  "near the top": "dekat atas range",
  "in the middle": "di tengah range",
  "near the bottom": "dekat bawah range",
  "at the bottom edge": "di tepi bawah range",
  "above range": "di atas range",
  "below range": "di bawah range",
};

/** Short Indonesian label for an exit reason; unknown reasons pass through. */
function closeReasonLabel(reason: string): string {
  const r = reason.toLowerCase();
  // Trailing before take-profit: "trailing take profit" contains both.
  if (r.includes("trailing")) return "Trailing TP (turun dari puncak)";
  if (r.includes("stop loss") || r.includes("stop_loss")) return "Stop loss";
  if (r.includes("take profit") || r.includes("take_profit")) return "Take profit";
  if (r.includes("pumped above range")) return "Harga pump di atas range";
  if (r.includes("out_of_range") || r.includes("out of range") || /\boor\b/.test(r)) return "Keluar range (OOR)";
  if (r.includes("low yield")) return "Yield terlalu rendah";
  return reason.length > 200 ? `${reason.slice(0, 197)}…` : reason;
}

function compactUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatDeployCard(r: DeployResult): string {
  const name = r.pool_name ?? shortAddr(r.pool_address);
  const bins = r.upper_bin - r.lower_bin;
  const pricePct = binRangeToPricePct(r.bin_step, r.lower_bin, r.upper_bin);
  const range = pricePct != null ? `${bins} bins · ±${pricePct.toFixed(1)}%` : `${bins} bins`;
  const where = PRICE_POSITION_LABEL[activeBinPosition(r.active_bin, r.lower_bin, r.upper_bin)];

  const signals: string[] = [];
  if (r.fee_tvl_ratio != null) signals.push(`Fee/TVL ${(r.fee_tvl_ratio * 100).toFixed(1)}%`);
  if (r.volatility != null) signals.push(`Vol ${r.volatility.toFixed(2)}`);
  if (r.organic_score != null) signals.push(`Organic ${r.organic_score.toFixed(0)}`);
  const token: string[] = [];
  if (r.mcap != null) token.push(`MCap ${compactUsd(r.mcap)}`);
  if (r.holders != null) token.push(`${r.holders.toLocaleString("en-US")} holders`);
  if (r.smart_wallets_present) token.push("smart wallet ada");

  return [
    `🟢 <b>OPEN</b> · <b>${esc(name)}</b>${dryTag(r.dry_run)}`,
    DIVIDER,
    `💰 Modal: <b>${fmtSol(r.amount_sol)} SOL</b>`,
    `🎯 Strategi: ${esc(STRATEGY_LABEL[r.strategy] ?? r.strategy)}`,
    `📐 Range: ${range}`,
    `📍 Harga: ${where}`,
    signals.length ? `📊 ${signals.join(" · ")}` : "",
    token.length ? `💎 ${esc(token.join(" · "))}` : "",
    DIVIDER,
    linkRow([
      ["Meteora", meteoraPoolUrl(r.pool_address)],
      ["Tx", txUrl(r.tx, r.dry_run)],
      ["Posisi", solscanAccountUrl(r.position_address)],
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatCloseCard(r: CloseResult): string {
  const pnl = r.final_pnl_pct;
  const [icon, verdict] =
    pnl == null ? ["📤", "CLOSE"] : pnl > 0 ? ["✅", "CLOSE · PROFIT"] : pnl < 0 ? ["🔴", "CLOSE · RUGI"] : ["⚪", "CLOSE · IMPAS"];
  const name = r.pair ?? shortAddr(r.pool_address);

  const lines = [`${icon} <b>${verdict}</b> · <b>${esc(name)}</b>${dryTag(r.dry_run)}`, DIVIDER];

  if (pnl != null) {
    // USD equivalent of the shown % against the deposit — keeps the two numbers consistent.
    const pnlUsd = r.initial_value_usd != null ? (r.initial_value_usd * pnl) / 100 : null;
    const usd =
      pnlUsd != null
        ? ` (${pnlUsd >= 0 ? "+" : "-"}$${Math.abs(pnlUsd) >= 0.01 ? Math.abs(pnlUsd).toFixed(2) : fmtUsd(Math.abs(pnlUsd))})`
        : "";
    const peak = r.peak_pnl_pct != null && r.peak_pnl_pct > 0 && r.peak_pnl_pct !== pnl ? ` · puncak ${signedPct(r.peak_pnl_pct)}` : "";
    lines.push(`${pnl >= 0 ? "📈" : "📉"} PnL: <b>${signedPct(pnl)}</b>${usd}${peak}`);
  }
  const value = r.final_value_usd != null ? `Nilai akhir: ${fmtDollar(r.final_value_usd)} · ` : "";
  lines.push(`💵 ${value}Fee: ${fmtDollar(r.fees_earned_usd)}`);

  const held: string[] = [];
  if (r.amount_sol_initial != null) {
    const usd = r.initial_value_usd != null ? ` (${fmtDollar(r.initial_value_usd)})` : "";
    held.push(`💰 Modal: ${fmtSol(r.amount_sol_initial)} SOL${usd}`);
  }
  if (r.age_minutes != null) held.push(`⏱ ${humanDuration(r.age_minutes)}`);
  if (held.length) lines.push(held.join(" · "));

  lines.push(`📝 Alasan: ${esc(closeReasonLabel(r.reason))}`);
  lines.push(DIVIDER);
  lines.push(
    linkRow([
      ["Meteora", r.pool_address ? meteoraPoolUrl(r.pool_address) : null],
      ["Tx", txUrl(r.tx, r.dry_run)],
      ["Posisi", solscanAccountUrl(r.position_address)],
    ]),
  );
  return lines.filter(Boolean).join("\n");
}

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const pairs = keys.slice(0, 3).map((k) => {
    const v = args[k];
    const s =
      typeof v === "string"
        ? v.length > 16
          ? `${v.slice(0, 13)}…`
          : v
        : typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : Array.isArray(v)
            ? `[${v.length}]`
            : "{…}";
    return `${k}=${s}`;
  });
  const suffix = keys.length > 3 ? " …" : "";
  return `(${pairs.join(", ")}${suffix})`;
}
