# PLAN — Meridian Live Deployment Runbook

> ⚠️ **HISTORICAL — superseded by [`deploy/homeserver/README.md`](homeserver/README.md).**
> This document describes the retired vivobook / Docker / Cloudflare-Access setup
> (`calisto.nafidinara.com`, GitHub Actions auto-deploy, Sage delegation over
> `sage-api.nafidinara.com`). Meridian now runs on a Windows homeserver as pm2
> processes behind a Cloudflare Tunnel at `au.alieffauzan.com`, with **no CI deploy
> pipeline** and **Sage disabled** (no `SAGE_*` env → local ReAct loop decider).
> Kept for history only. Do not follow these steps against the current box.

> **⚠️ HISTORICAL** — original vivobook rollout plan. Ran on Tencent HK VPS via
> CI/CD from 2026-07 through 2026-08-01, then migrated back to the vivobook.
> **Current runbook: [`OPERATIONS.md`](OPERATIONS.md).** Migration story:
> [`MIGRATION-vivobook-runbook.md`](MIGRATION-vivobook-runbook.md).

Companion to [PRD-deployment.md](./PRD-deployment.md). Execution order, exact
commands, verification, and the live cutover. Goal: **live, not dry-run.**

Host: vivobook `nafidinara@100.100.154.123` (reach over Tailscale — `tailscale
ping 100.100.154.123` first if SSH times out; the box Wi-Fi is flaky).

Legend: ✅ done · ⏳ blocked on operator · ▶ automated by assistant

---

## Phase 0 — Prerequisites  ✅ (complete)

- ✅ Code rsynced to `~/meridian` (dashboard branch, no secrets/state)
- ✅ Deploy artifacts: `Dockerfile`, `docker-compose.yml`, `.dockerignore`,
  `ecosystem.config.cjs` (daemon + web apps)
- ✅ Image built: `meridian:latest`
- ✅ State volume dir `~/meridian-data`
- ✅ `.env` scaffolded (600), bridge token generated
- ✅ External `web` docker network present, Caddy attached

## Phase 1 — Secrets  ⏳ (operator)

Edit `~/meridian/.env`, replace the 4 `REPLACE_ME_*` values:

```bash
ssh nafidinara@100.100.154.123
nano ~/meridian/.env
```
| Key | Value |
|---|---|
| `WALLET_PRIVATE_KEY` | base58 wallet private key (the trading wallet) |
| `RPC_URL` | mainnet RPC, e.g. `https://mainnet.helius-rpc.com/?api-key=…` |
| `OPENROUTER_API_KEY` | `sk-or-…` |
| `HELIUS_API_KEY` | Helius key (wallet balances) |

Optional ops: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS`.

**Gate:** `grep -c REPLACE_ME ~/meridian/.env` must return `0` before Phase 2.

## Phase 2 — Boot (staged: dry-run smoke → live)  ▶

The assistant runs a **60-second dry-run smoke** first (still requires real keys —
wallet is bs58-parsed at boot and cycles call the LLM), confirms the container is
healthy, then flips to live. This catches a crash-on-boot **before** real SOL can
move. Per operator instruction the end state is live; the smoke is only a safety
gate, not the destination.

```bash
cd ~/meridian
# 2a. smoke (DRY_RUN=true already in .env)
docker compose up -d
docker compose logs -f --tail=60 meridian     # watch ~60s
```
Smoke pass = both PM2 apps online, bridge line printed, no restart loop, web
answers on :3000.

```bash
# 2b. flip to live
sed -i 's/^DRY_RUN=true/DRY_RUN=false/' .env
sed -i 's/^MERIDIAN_WRITE_UNSAFE=false/MERIDIAN_WRITE_UNSAFE=true/' .env
docker compose up -d          # recreates with new env
docker compose logs -f meridian
```
Live pass = log shows `MERIDIAN_WRITE_UNSAFE=true — real Meteora write paths ARMED`.

## Phase 3 — Verify  ▶

```bash
# container + processes
docker compose ps
docker exec meridian pm2 list
# bridge (in-container, token from .env)
docker exec meridian sh -lc 'curl -s -H "authorization: Bearer $DASHBOARD_TOKEN" \
  http://127.0.0.1:8787/state | head -c 300'
# web up
docker exec meridian sh -lc 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000'
```
Expect: container Up, 2 pm2 procs online, bridge returns JSON, web returns `200`.

## Phase 4 — Public dashboard (Caddy + Cloudflare)  ⏳▶

**4a. Caddy route (assistant, on box).** Add to `/opt/stack/caddy/Caddyfile`:
```
http://meridian.nafidinara.com {
    reverse_proxy meridian:3000
}
```
Reload: `cd /opt/stack && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` (or `docker compose restart caddy`).

**4b. Cloudflare Tunnel hostname (operator, CF dashboard).**
Zero Trust → Networks → Tunnels → `vivobook` → Public Hostnames → **Add**:
- Subdomain `meridian`, domain `nafidinara.com`
- Service: `HTTP` → `caddy:80`

**4c. Cloudflare Access policy (operator, CF dashboard) — MANDATORY.**
Zero Trust → Access → Applications → **Add** self-hosted app:
- Domain `meridian.nafidinara.com`
- Policy: Allow → emails = `nafidinara07@gmail.com` (one-time PIN or Google).

**Gate:** hitting `https://meridian.nafidinara.com` shows the CF Access login,
not the dashboard, until authenticated.

## Phase 5 — Live cutover confirmation & monitor  ▶

- Trigger a screening pass (Telegram `/screen` or wait for the cron cycle).
- Watch first deploy/close in `docker compose logs -f meridian` + Telegram.
- Confirm the position on-chain (Solana explorer) and in the dashboard.
- Reboot test: `sudo reboot`, then confirm `meridian` auto-starts with state intact.

## Rollback / kill switch

```bash
cd ~/meridian
docker compose stop                               # halt daemon (open positions untouched)
# or disarm writes, keep watching:
sed -i 's/^MERIDIAN_WRITE_UNSAFE=true/MERIDIAN_WRITE_UNSAFE=false/' .env && docker compose up -d
```

## Ops runbook (steady state)

```bash
docker compose logs -f meridian          # live logs
docker exec meridian pm2 logs            # per-process
docker exec meridian pm2 restart all     # bounce processes
# update code:
rsync … ~/meridian/ ; docker compose up -d --build   # rebuild + recreate
```

## Known follow-ups

- Trim C/C++ toolchain (`python3 make g++`) from the Dockerfile — Solana deps are
  pure-JS; the layer cost ~11 min on the box's slow Wi-Fi. Rebuild without it and
  confirm `npm ci` still succeeds.
- Optionally point daemon logs to `/opt/data/logs` so the dashboard's actions
  panel has data (TS logger currently writes stdout only).
