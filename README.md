# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs. TypeScript rewrite.**

**Links:** [Website](https://agentmeridian.xyz) | [Telegram](https://t.me/agentmeridian) | [X](https://x.com/meridian_agent)

Meridian runs continuous screening and management cycles, deploying capital into
high-quality Meteora DLMM pools and closing positions based on live PnL, yield,
and range data. It learns from every position it closes.

---

## Status

Runs on the strict TypeScript rewrite (branch `rewrite-ts`, tag `v2.0.0`).
Hexagonal-lite architecture: `src/domain/` (pure) / `src/ports/` (interfaces) /
`src/adapters/` (impls) / `src/app/` (services) / `src/entrypoints/` (composition).
Zod is the single source of truth for schemas, types, and OpenAI tool
definitions.

Legacy JavaScript daemon is preserved at git tag `legacy-js` for instant
rollback (`git checkout legacy-js`).

---

## What it does

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds
  (fee/TVL ratio, organic score, holder count, mcap, bin step) and surfaces
  high-quality opportunities. A **trend-independent drawdown gate** (`maxFromHighPct`,
  default 35%) rejects candidates deep below their window high even when the last
  candles bounce green — a dead-cat bounce is not a recovery.
- **Manages positions** — monitors, claims fees, and closes LP positions
  autonomously via deterministic rules (no LLM in the management loop). An optional
  **smart-exit regime engine** (`smartExitEnabled`) replaces the static stop with a
  CATASTROPHIC / DYING / HEALTHY / AMBIGUOUS classifier — cutting collapsing positions
  early, holding healthy in-range fee-earners past the stop, and escalating the
  genuinely ambiguous ones to Sage for a CLOSE/HOLD verdict. Dark by default; armed
  from the dashboard Config → Exit rules tab.
- **Trailing take-profit** — dedicated 30s poller with a 15s two-phase drop
  confirm before firing a close (plus a catastrophic-floor / out-of-range fast-cut
  when smart-exit is armed).
- **Learns from performance** — records structured lessons + closed-trade
  performance to `lessons.json` (each `PerformanceRecord` now carries
  `base_mint`, `entry_technicals`, `exit_technicals`), evolves screening
  thresholds based on closed position history, and shares learning via HiveMind.
  Every screening cycle injects `── LESSONS ──` (pinned + recent 5), per-candidate
  `history:` (pool + base_mint match against prior closes), a `PRIOR EXPERIENCE:`
  portfolio aggregate (wins/losses bucketed by strategy / volatility / entry_mcap),
  and inline `technicals:` (15m + 1h OHLCV features from GeckoTerminal) into the
  Sage delegation prompt.
- **Retrospective loop** — `mrd_get_performance` + `mrd_get_decisions` +
  `mrd_add_lesson` (plugin tools) power the Telegram flow *"we had N losses in
  a row — analyze and save a lesson"*. Saved rules auto-inject into the next
  screening cycle's LESSONS block; Sage self-authored a spike-top veto + a
  sustained-downtrend veto + an extreme-volatility veto against 6 recent SLs
  on 2026-08-10.
- **Technical analysis** — `mrd_get_pool_kline` returns multi-timeframe OHLCV
  + 13 computed features (spike detection, at_local_top, ATR%, vol spike,
  trend, swing-low support proximity + touch count, consecutive red-candle streak).
  Screening pre-fetches these inline per candidate; the tool is exposed for
  interactive analysis and post-mortems in the Sage Telegram group.
- **Telegram REPL** — in production, screening + conversational control is
  delegated to **Sage** (Hermes agent, memory-backed) via the intra-host bridge
  (see `deploy/SAGE-MERIDIAN-ROLLOUT.md`). Meridian keeps outbound cards
  (deploy/close/OOR alerts, daily briefings) posted from the same @SageHermesAnd_bot
  identity; Sage handles all inbound. Standalone Meridian mode still supports its
  own inbound long-poll REPL when `MERIDIAN_TELEGRAM_INBOUND` is unset.
- **Sage `meridian-ops` skill** — Sage's operational knowledge (mode detection,
  `mrd_*` tool inventory, playbooks, config-edit protocol, the exit-advisor
  CLOSE/HOLD contract, boundaries) lives in
  `deploy/hermes-meridian-plugin/skill/SKILL.md` and installs to Sage as a
  Hermes skill. Sage plays two Meridian roles — screening decider and exit
  advisor — and self-edits this skill, so **pull the live copy before editing**.
  `mrd_update_config` is human-gated at the bridge (`cycle_id` present ⇒ 403),
  so Sage cannot patch config autonomously.
- **Discord signals** — optional Discord listener queues LP Army channel calls
  for screening (retained from legacy — separate subproject).

---

## Architecture at a glance

```
   ┌────────────────────────────────────────────────────────┐
   │ entrypoints/daemon.ts    ← composition root (~500 LOC) │
   ├────────────────────────────────────────────────────────┤
   │ app/                     ← agent loop, cycles, poller  │
   ├────────────────────────────────────────────────────────┤
   │ domain/                  ← pure rules + Zod schemas    │
   ├────────────────────────────────────────────────────────┤
   │ ports/                   ← interfaces only             │
   ├────────────────────────────────────────────────────────┤
   │ adapters/                ← concrete impls behind ports │
   │  chain/{dry-run, meteora/…}    llm/{openrouter, fake}  │
   │  market/{jupiter-*, meteora-*, rugcheck,               │
   │          geckoterminal-kline}                          │
   │  notify/{telegram, telegram-inbound}                   │
   │  swap/jupiter-swap        hivemind/agent-meridian      │
   │  persistence/json/…       scheduler/{interval, manual} │
   └────────────────────────────────────────────────────────┘
```

472 unit tests across 47 files.

---

## Requirements

- Node.js 22+
- [OpenRouter](https://openrouter.ai) API key (or any OpenAI-compatible endpoint)
- Solana RPC — Helius recommended
- Base58 wallet private key
- Optional: Telegram bot token + chat id for the REPL bridge

---

## Quick start

```bash
npm install
cp user-config.example.json user-config.json   # edit thresholds to taste
npm run build                                  # tsc → dist/
npm start                                      # boot the daemon
```

### Environment flags

| Var | Values | Purpose |
|---|---|---|
| `MERIDIAN_CHAIN` | `dryrun` (default) / `meteora` | Which chain adapter |
| `MERIDIAN_MARKET` | `real` (default when chain=meteora) / `fake` | Real vs mock market adapters |
| `MERIDIAN_PRICE` | `jupiter` / `static` | SOL/USD price source |
| `MERIDIAN_AUTONOMOUS` | `true` / unset | Start cron loop (screening + management + pnl-poller + briefing + health + hivemind + telegram inbound) |
| `MERIDIAN_WRITE_UNSAFE` | `true` / unset | **Arms real Meteora write paths.** Without this, deploy/close/claim throw `MeteoraWritePathNotPortedError`. |
| `MERIDIAN_STATE_DIR` | absolute path | Directory for JSON state files (defaults to `cwd`) |
| `MERIDIAN_FROZEN_TIME` | ISO string | Freeze clock for deterministic runs |
| `MERIDIAN_DEMO` | `true` / unset | Force the fake LLM script for one-shot demo |
| `RPC_URL`, `WALLET_PRIVATE_KEY` | | Required when `MERIDIAN_CHAIN=meteora` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | | Enables Telegram outbound (+ inbound if `MERIDIAN_TELEGRAM_INBOUND` unset). In production the token is shared with Sage (Hermes) — single-bot identity, Meridian only writes. |
| `TELEGRAM_ALLOWED_USER_IDS` | comma list | Required for group chats |
| `MERIDIAN_TELEGRAM_INBOUND` | `false` / unset | `false` = daemon never starts inbound REPL (required when the token is shared with another poller). |
| `MERIDIAN_DECIDER` | `sage` / unset | `sage` delegates the screening deploy decision to the external Sage (Hermes) agent via `SAGE_BASE_URL` (Path 2); anything else = local LLM loop. |
| `SAGE_BASE_URL`, `SAGE_API_KEY`, `SAGE_SESSION_KEY`, `SAGE_TIMEOUT_MS` | | Sage endpoint config; only read when `MERIDIAN_DECIDER=sage`. |
| `OPENROUTER_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | | LLM provider config |
| `DASHBOARD_ENABLED` | `true` / unset | Start the localhost control-dashboard bridge. Without it the bridge module is never imported — daemon behavior is identical. |
| `DASHBOARD_PORT` | port (default `8787`) | Bridge TCP port (bound to `127.0.0.1` only) |
| `DASHBOARD_TOKEN` | secret | **Required** to arm the bridge — it refuses to listen without a non-empty token. The web app sends it as `Bearer`. |

### Modes

```bash
# One-shot dryrun with fake LLM
MERIDIAN_DEMO=true npm start

# Real read-only Meteora observation (no writes possible)
MERIDIAN_CHAIN=meteora \
  RPC_URL="https://…" \
  WALLET_PRIVATE_KEY="…" \
  npm start

# Autonomous production loop with real Telegram + HiveMind
MERIDIAN_AUTONOMOUS=true \
  MERIDIAN_CHAIN=meteora \
  MERIDIAN_MARKET=real \
  MERIDIAN_WRITE_UNSAFE=true \
  TELEGRAM_BOT_TOKEN="…" \
  TELEGRAM_CHAT_ID="…" \
  npm start
```

---

## Control dashboard

An optional web dashboard lives under `dashboard/`:

- `dashboard/web/` — Next.js app (its own npm project). Talks only to same-origin
  `/api/*` proxies, which forward to the bridge with the `Bearer` token server-side —
  the token never reaches the browser.
- `src/adapters/dashboard/` — the **bridge**: a `node:http` server (zero external deps,
  bound to `127.0.0.1` only) wired to the daemon's DI context. Exposes `/health`,
  `/state/positions`, `/state/summary`, `/state/file/:name` (whitelisted, `user-config`
  redacted), `/events` (SSE, piggybacks the PnL-poller cache — no new RPC), `POST /tool`
  (allowlisted; write tools require `confirm:true` + an in-flight lock), and `POST /chat`
  (streaming GENERAL agent tick restricted to a read-only tool surface).

Enable it at boot:

```bash
DASHBOARD_ENABLED=true \
  DASHBOARD_TOKEN="$(openssl rand -hex 16)" \
  MERIDIAN_AUTONOMOUS=true \
  npm start

# then, in dashboard/web:  BRIDGE_TOKEN=<same token> npm run dev
```

See `dashboard/PRD.md`, `dashboard/Design.md`, and `dashboard/plan/` for the full spec.

---

## Production deployment

Meridian runs live on a **Windows homeserver** as two **pm2** processes — the
`meridian` trading daemon and the `meridian-web` Next.js dashboard. Native Node:
no Docker, no Caddy. The dashboard reaches the internet through an outbound-only
**Cloudflare Tunnel** (`cloudflared` as a Windows service) at
`https://au.alieffauzan.com` — **no router port is opened**. Two auth doors sit in
front of it: optional Cloudflare Access at the edge, plus the app's own 6-digit
PIN. The bridge on `8787` only ever listens on `127.0.0.1` and is never exposed.
Deploys are manual: `git pull`, build, `pm2 restart`.

**Full operations manual:
[`deploy/homeserver/README.md`](deploy/homeserver/README.md)** — tunnel setup,
pm2 autostart, secrets, PIN auth, and troubleshooting. Start there for anything
deploy-related.

> **Historical.** Meridian previously ran as Docker containers on the vivobook
> box at `calisto.nafidinara.com`, auto-deployed from the `dashboard` branch via
> GitHub Actions. That setup is **retired**; `deploy/OPERATIONS.md` and
> `deploy/MIGRATION-vivobook-runbook.md` are kept for history only.

---

## Rollback

Legacy JS daemon lives at the `legacy-js` git tag.

```bash
git checkout legacy-js
npm ci
npm start                 # runs the legacy JS daemon (index.js)
```

Use this if any TS phase misbehaves in production. See
`scripts/parallel-run/README.md` for the pre-cutover parallel-run procedure that
gates every future rewrite.

---

## Development

```bash
npm run typecheck         # strict tsc
npm run test              # typecheck + vitest
npm run dev               # tsx watch, DRY_RUN=true
npm run build             # tsc → dist/
```

See `CLAUDE.md` for the engineering manual, `DESIGN-typescript-rewrite.md` for
the architecture, and `HANDOFF-typescript-rewrite.md` for the phase-by-phase
history.
