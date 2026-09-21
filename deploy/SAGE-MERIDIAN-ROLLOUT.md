# Sage ⇄ Meridian (Path 2) — live architecture & operations

> ⚠️ **HISTORICAL — superseded by [`deploy/homeserver/README.md`](homeserver/README.md).**
> This document describes the retired vivobook / Docker / Cloudflare-Access setup
> (`calisto.nafidinara.com`, GitHub Actions auto-deploy, Sage delegation over
> `sage-api.nafidinara.com`). Meridian now runs on a Windows homeserver as pm2
> processes behind a Cloudflare Tunnel at `au.alieffauzan.com`, with **no CI deploy
> pipeline** and **Sage disabled** (no `SAGE_*` env → local ReAct loop decider).
> Kept for history only. Do not follow these steps against the current box.

**⚠️ SUPERSEDED (2026-08-01).** This doc describes the Tencent-era Path 2 architecture
where Meridian (on Tencent HK VPS) reached Sage on vivobook over a Cloudflare Tunnel
(`sage-api.nafidinara.com` + `mrd-bridge.nafidinara.com`) with CF Access service tokens.
Meridian is now co-located with Sage on vivobook; delegation is intra-host via
`http://host.docker.internal:8643` (socat → hermes:8642, no CF Access). Current
architecture in [`OPERATIONS.md §1`](OPERATIONS.md#1-architecture); migration story in
[`MIGRATION-vivobook-runbook.md`](MIGRATION-vivobook-runbook.md). Kept for git-blame
context on the delegation design.

---

**Status: LIVE (2026-07-14).** Sage (a Hermes agent on the vivobook home server) is
Meridian's primary screening decider. It reasons with its own memory, deploys real
funds through Meridian's dashboard bridge, and answers questions in the Telegram
group. Meridian's local LLM loop (OpenRouter) is the automatic fallback. Deterministic
rules (screening hard-filter, the 5 close rules, management exits) are unchanged.

This doc is the single source of truth for the integration. Code internals live in
[`../CLAUDE.md`](../CLAUDE.md); general Meridian ops in [`OPERATIONS.md`](OPERATIONS.md).

---

## What runs where

| Host | Piece |
|------|-------|
| **HK VPS** `ubuntu@101.32.216.139` | `meridian` daemon (owns netns; bridge on 127.0.0.1:8787), `meridian-web`, `meridian-cloudflared`, **`meridian-bridge-proxy`** (socat 8788→8787), `n8n`. |
| **vivobook** `nafidinara@…` (Tailscale/CF) | `hermes` container: 6 agent gateways incl. **`sage`** (Telegram + api_server:8642) + the `meridian` plugin; `hermes-dashboard`. |
| **Cloudflare** | zone `nafidinara.com`; CF Access service-token-gated hostnames `mrd-bridge.nafidinara.com` (→ HK bridge) and `sage-api.nafidinara.com` (→ Sage api). |

## Data flow

```
AUTONOMOUS SCREENING (Sage decides, real funds)
  Meridian cron (HK)                                   Sage api (vivobook)
    preflight + hardFilter + rankCandidates  [deterministic, unchanged]
    enrichCandidates: parallel rugCheck + tokenInfo.getHolders per pick,
      3s per-call timeout, fail open → inline "diligence:" line per candidate
    POST /v1/chat/completions ──CF Access──▶  reason w/ meridian-trading memory
      {tailored goal + candidates + diligence + cycle_id}   pick a candidate
      X-Hermes-Session-Key: meridian-trading           call mrd_deploy_position(cycle_id)
      timeout 90s                                            │
                    mrd-bridge.nafidinara.com ◀──CF Access──┘
                    → cloudflared → bridge-proxy:8788 → bridge 127.0.0.1:8787
                      → executeTool → safety gates → meteora write → on-chain
    ◀── prose summary ; Meridian reconciles positions(force) → "deploy landed"
    on timeout/transport error → OpenRouter local loop (same cycle_id; bridge
      idempotency blocks a double-deploy)

ON-DEMAND (you ↔ Sage in the Meridian Telegram group)
  you → Sage (@SageHermesAnd_bot) → mrd_get_positions / analyze / close → bridge
  Meridian posts ✅Deployed / 📪Closed cards from the SAME bot (@SageHermesAnd_bot)
    — Meridian's TELEGRAM_BOT_TOKEN = Sage's token since 2026-08-02 (Calisto retired,
      single-bot identity, Hermes handles all inbound polling)
```

## Live config (as of 2026-08-02, post single-bot swap)

**Meridian (vivobook) `~/meridian/.env`** — screening delegated + telegram token shared with Sage:
```
MERIDIAN_DECIDER=sage                       # also set as compose env default
SAGE_BASE_URL=http://host.docker.internal:8643   # intra-host, no CF Access
SAGE_API_KEY=<sage API_SERVER_KEY>          # matches ~/.hermes/profiles/sage/.env
SAGE_SESSION_KEY=meridian-trading
SAGE_TIMEOUT_MS=90000
MERIDIAN_TELEGRAM_INBOUND=false             # also compose default; must stay false
TELEGRAM_BOT_TOKEN=<Sage bot token>         # = ~/.hermes/profiles/sage/.env TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=-1004388814457             # unchanged, same group
```
`user-config.json`: `deployAmountSol=0.2`, `maxPositions=3`, chain=meteora. Backups on
disk: `~/meridian/.env.bak-sagebot-*` (pre-token-swap Calisto config). SAGE_CF_ACCESS_*
no longer needed (intra-host path).
`meridian-bridge-proxy` is a durable **compose service** in `docker-compose.yml`
(`network_mode: service:meridian`) so `up -d --force-recreate` re-attaches it every deploy.

**Sage's Meridian toolset (9 tools, source of truth: [`hermes-meridian-plugin/`](hermes-meridian-plugin/)):**

| Tool | Kind | Notes |
|---|---|---|
| `mrd_get_positions` / `mrd_get_summary` / `mrd_get_wallet` / `mrd_get_candidates` | read | Any time. |
| `mrd_get_config` | read | Reads `user-config.json` via bridge `GET /state/file/user-config` (bridge uses `ctx.configPath`, not `stateDir` — 2026-08-02 fix). Secrets redacted server-side. |
| `mrd_deploy_position` | write | Autonomous (screening cycle, `cycle_id` verbatim) OR human-requested. |
| `mrd_close_position` | write | Human-only. **Requires `reason` string** — Zod-min:1 on Meridian side (2026-08-02 fix). |
| `mrd_claim_fees` | write | Human-only. Meridian auto-claims via management cycle. |
| `mrd_update_config` | write | **Human-only, HARD-GATED at the bridge**: `POST /tool` with `name=update_config` + any `cycle_id` returns 403 (`human-gated; not permitted inside a delegation cycle`). Screening delegation always carries a `cycle_id`; user chats never do. Prompt-level guardrails in the plugin schema + Meridian's Sage-delegation system prompt back this up, but the bridge is authoritative. |

**Sage's `meridian-ops` skill (source of truth: [`hermes-meridian-plugin/skill/SKILL.md`](hermes-meridian-plugin/skill/SKILL.md)):**
- Installed at `~/.hermes/profiles/sage/skills/meridian-ops/SKILL.md` on vivobook.
- Sage's SOUL.md is intentionally NOT modified — Sage remains a research analyst by default; the skill loads on demand when Meridian topics come up (auto-invoked by keyword: "Meridian", "PnL", "stop loss", "positions", "config", "deploy", "screening cycle", …).
- Covers: mode detection (autonomous screening vs human operator), full `mrd_*` tool inventory + when-to-call, screening cycle rules, human operator playbook by request shape, config-edit protocol, hard boundaries, memory hygiene, style, trust boundary, quick-reference cheat sheet.
- Re-deploy: `scp deploy/hermes-meridian-plugin/skill/SKILL.md vivobook-public:~/.hermes/profiles/sage/skills/meridian-ops/SKILL.md && ssh vivobook-public 'docker exec hermes /command/s6-svc -r /run/service/gateway-sage'`.

**Sage terminal PATH fix (vivobook-only, not in repo):** `gmgn-cli` and other tools installed to `~/.local/bin` weren't on the default shell PATH. Fix: `~/.hermes/profiles/sage/home/.bashrc` contains `export PATH="$HOME/.local/bin:$PATH"`. `auto_source_bashrc` is already true in Sage's `config.yaml`.

**Sage (vivobook)** — `~/.hermes/profiles/sage/.env`:
```
API_SERVER_KEY=<secret>            API_SERVER_HOST=127.0.0.1   API_SERVER_PORT=8642
MERIDIAN_BRIDGE_URL=https://mrd-bridge.nafidinara.com
MERIDIAN_BRIDGE_TOKEN=<meridian DASHBOARD_TOKEN>
MERIDIAN_BRIDGE_CF_CLIENT_ID=207fb797a4051e5696b9d4c426c110e6.access
MERIDIAN_BRIDGE_CF_CLIENT_SECRET=<secret>
```
`~/.hermes/profiles/sage/config.yaml`:
```yaml
toolsets: [hermes-cli, meridian]
platforms: { api_server: { enabled: true, extra: { port: 8642, host: 127.0.0.1 } } }
plugins:   { enabled: [meridian] }
telegram:
  allowed_chats: '-1004388814457'
  extra:
    require_mention: false                    # reply to every group message
    exclusive_bot_mentions: false
    observe_unmentioned_group_messages: true  # always ingest group context
    allowed_chats: '-1004388814457'
```
Plugin source of truth: [`hermes-meridian-plugin/`](hermes-meridian-plugin/) in this
repo. It must be installed at **`~/.hermes/profiles/sage/plugins/meridian/`** (the
profile dir — Hermes sets `HERMES_HOME` to the profile when run with `-p sage`).

## Cloudflare transport

- DNS: proxied CNAMEs `mrd-bridge`→`eaf7c027-…cfargotunnel.com`, `sage-api`→`a33a2420-…cfargotunnel.com`.
- CF Access self-hosted apps in front of both hostnames, policy = service token `meridian-sage`.
- Tunnel ingress (remotely-managed, edited via API): meridian-vps adds
  `mrd-bridge→http://meridian:8788`; vivobook adds `sage-api→http://192.168.1.26:8643`.
- vivobook `sage-api-proxy` socat (host net) `0.0.0.0:8643→127.0.0.1:8642`; **an iptables
  INPUT allow is required** (`-s 172.18.0.0/16 --dport 8643 ACCEPT`) — the host drops
  container→host ports except 22.
- Both callers send an explicit `User-Agent` (CF blocks default programmatic UAs → 403/err 1010).
- Re-create the CF side idempotently: `CF_DNS_TOKEN=… CF_ACCESS_TOKEN=… bash deploy/cf-setup-path2.sh`.

## Operating

- **Reload Sage only** (config change, no 6-agent blip):
  `docker exec hermes /command/s6-svc -r /run/service/gateway-sage`
- **Redeploy Meridian**: push to `dashboard` → CI builds + `docker compose up -d --force-recreate`
  (recreates meridian + web + bridge-proxy together). Runtime changes need a src/compose
  edit (docs/`.github`-only pushes are scope=none, skipped).
- **Verify transport**:
  `curl -A meridian-daemon/1.0 -H 'CF-Access-Client-Id: …' -H 'CF-Access-Client-Secret: …' -H 'Authorization: Bearer <key>' https://sage-api.nafidinara.com/v1/models` → 200;
  same shape against `https://mrd-bridge.nafidinara.com/state/positions?force=1` with the bridge DASHBOARD_TOKEN → 200.
- **Confirm armed**: HK `docker compose logs meridian | grep decider` → `decider: SAGE … fallback armed`.

## Rollback

- Disarm Sage (back to local loop): remove `MERIDIAN_DECIDER=sage` from `docker-compose.yml` environment (or set `=loop`), redeploy.
- Restore Calisto bot identity + LLM replies: on vivobook, `cp ~/meridian/.env.bak-sagebot-<ts> ~/meridian/.env`, remove `MERIDIAN_TELEGRAM_INBOUND=false` from compose env, `docker compose up -d --force-recreate meridian`. ⚠ Only safe if Hermes is not also polling the token — Meridian and Hermes must not share a token if both listen.
- Sage out of group: set `require_mention: true` (or remove `allowed_chats`), s6 restart sage.
- Backups on disk: HK `.env.bak-path2`, `user-config.json.bak-path2`; vivobook sage `config.yaml.bak-path2`, `.env.bak-path2`, `config.yaml.bak-group`.

## Gotchas hit (and fixed) — do not re-trip

1. **Hermes api is agentic**, not a raw model — it never returns `tool_calls` (tool_execution: server). So this is agentic *delegation*, not an LLMClient swap.
2. **User plugins load from the PROFILE dir** `~/.hermes/profiles/<p>/plugins/`, need `plugins.enabled: [<name>]`, and must use **relative imports** (`from .tools import …`, not `from plugins.meridian.…`).
3. **Cloudflare blocks default UAs** (Python-urllib / undici) with 403 / error 1010 → set explicit `User-Agent` on both callers.
4. **Host firewall drops container→host ports** except 22 → the `sage-api` origin needs the iptables allow for 8643.
5. **bridge-proxy orphans on meridian recreate** unless it's a compose service sharing meridian's netns (fixed).
6. **Delegation prompt must be Sage-tailored** — sending Meridian's full SCREENER prompt (12 tool names Sage lacks) made Sage flail and time out; the focused "pick a candidate, call mrd_deploy_position, no other tools" prompt is what makes Sage actually decide.
7. **Never double-restart `docker compose … gateway` mid-drain** — profiles get stranded in `draining` (reconcile only starts prior_state=running). One restart, full 120s settle; or reload one profile via s6.
8. **Sage can't run diligence tools inside a cycle** (90s timeout, prompt forbids it) — early cycles ended with "requires GMGN-confirmed improvement, blocked by cycle constraints", leaving the wallet idle. Fix (2026-08-02): Meridian pre-enriches candidates itself (`enrichCandidates` in `src/app/screening/cycle.ts`) — parallel rugCheck + holder lookups per pick, 3s per-call timeout, fail open. The inline `diligence:` line gives Sage GMGN-equivalent verification for free; the sage prompt now explicitly says "the diligence data is already in the candidate block — do NOT fetch more". Fresh diligence is also the signal that justifies overriding a stale in-memory veto (token status changes minute-to-minute).

## Post-cutover milestones

- **2026-08-09 (Phase 1)** — history injection. Every screening cycle preflight now
  loads `recentPerformance(50)` + `listLessons({limit:20})` and injects per-candidate
  `history:` (pool + base_mint match count + avg pnl% + last-loss-ago) + a portfolio
  aggregate `PRIOR EXPERIENCE:` block (wins/losses bucketed by strategy / volatility /
  entry_mcap). Sage's `sageSystemPrompt` finally gets the `── LESSONS ──` block that
  the local-loop `buildSystemPrompt` already had — pinned + recent 5. PerformanceRecord
  gained `base_mint` so same-token matches survive across pools.
- **2026-08-09 (Phase 2)** — retrospective trio. Plugin gained `mrd_get_performance`,
  `mrd_get_decisions`, `mrd_add_lesson` (tools count 9 → 12). Sage's Telegram flow:
  *"we had N losses, analyze and save a lesson"* now pulls closed trades + screening
  decisions, pattern-mines, proposes a one-sentence rule with confirming closes ≥3,
  saves on user confirmation. Lessons flow back through the LESSONS block from Phase 1.
- **2026-08-10 (Phase 3)** — technical analysis. New `KlineClient` port +
  `geckoterminal-kline` adapter (keyless OHLCV, 60s TTL, fail-open). `enrichTechnicals`
  runs alongside `enrichCandidates` per screening cycle — 15m + 1h computed features
  (spike_pct, at_local_top, ATR%, vol_spike, trend, support proximity + touches)
  inline as a `technicals:` line per candidate. New `mrd_get_pool_kline` plugin tool
  (12 → 13) for interactive analysis. `PerformanceRecord.entry_technicals` +
  `exit_technicals` + `TrackedPosition.entry_technicals` frozen at deploy/close for
  retrospective pattern-mining. Sage self-authored 5 pinned lessons (spike-top /
  far-support / downtrend / extreme-volatility vetoes + strategy-per-candidate rule)
  after its own 6-SL retro, and self-patched `skill/SKILL.md` +
  `skill/references/stop-loss-postmortem-aug-2026.md`. **Always `scp` those files
  BACK to the repo before pushing local — Sage's edits live on vivobook first.**
9. **`add_lesson` sanitizer stripped `<` `>`** — HTML-injection defense that made no
   sense for LLM-prompt content. Sage's TA-rule comparators ("1h ATR > 25%",
   "from_high < -30%") were silently mangled to whitespace. Fixed 2026-08-10; the two
   affected pinned lessons were hand-patched in the host `lessons.json`.
