# PRD — Meridian Production Deployment (vivobook home server)

> ⚠️ **HISTORICAL — superseded by [`deploy/homeserver/README.md`](homeserver/README.md).**
> This document describes the retired vivobook / Docker / Cloudflare-Access setup
> (`calisto.nafidinara.com`, GitHub Actions auto-deploy, Sage delegation over
> `sage-api.nafidinara.com`). Meridian now runs on a Windows homeserver as pm2
> processes behind a Cloudflare Tunnel at `au.alieffauzan.com`, with **no CI deploy
> pipeline** and **Sage disabled** (no `SAGE_*` env → local ReAct loop decider).
> Kept for history only. Do not follow these steps against the current box.

> **⚠️ HISTORICAL** — this was the original design for the vivobook home server
> (single container, Caddy + Cloudflare Tunnel). Production ran on a Tencent HK
> VPS with a split-container + CI/CD setup from 2026-07 through 2026-08-01, then
> migrated back to the vivobook (co-located with Sage, intra-host delegation).
> **Current source of truth: [`OPERATIONS.md`](OPERATIONS.md).** Migration
> runbook: [`MIGRATION-vivobook-runbook.md`](MIGRATION-vivobook-runbook.md).
> Kept for design-rationale reference.

**Status:** in progress · **Owner:** Alfara Nafi Dinara · **Date:** 2026-07-12
**Source branch:** `dashboard` · **Target host:** vivobook (`100.100.154.123`, Tailscale)

---

## 1. Objective

Run the Meridian autonomous DLMM LP agent **24/7, live (real funds)** on the
vivobook home server, with the Next.js control dashboard reachable publicly on a
`nafidinara.com` subdomain **behind Cloudflare Access authentication**.

Success = the daemon screens/deploys/manages Meteora positions on-chain without a
human in the loop, survives host reboots, and the operator can observe + control
it from the web dashboard and Telegram.

## 2. Background & platform decision

Meridian is a **persistent Node 22 daemon**, not a request/response web app:
`node-cron` screening + management cycles, a 35s Telegram long-poll, a 30s PnL
poller, and it holds a wallet private key that signs on-chain transactions.

**Vercel / Cloudflare Workers were rejected** — they are serverless/edge with no
long-running process and cold starts; they physically cannot host this daemon.
The vivobook is already a 24/7 Docker host (Caddy + Cloudflare Tunnel + Postgres +
the sibling "Hermes" Telegram-agent), so it is the correct target. The dashboard
*frontend* could run on Vercel but it controls a live trading wallet, so it stays
on the same private box behind Cloudflare Access.

## 3. Architecture

```
Cloudflare edge (TLS + Access auth)
        │  meridian.nafidinara.com
        ▼
cloudflared (tunnel "vivobook", outbound-only)
        │  http://caddy:80  (Host header)
        ▼
caddy  ── web docker network ──►  meridian:3000  (Next.js dashboard)
                                        │ localhost bridge
                                        ▼
                                  127.0.0.1:8787  (daemon control bridge)
```

- **One container `meridian`** on the existing external `web` network. PM2
  (`pm2-runtime`, PID 1) supervises two processes: the trading **daemon**
  (`dist/entrypoints/daemon.js`) and the **Next.js web** (`next start -p 3000`).
- **Bridge binds `127.0.0.1:8787` only** (hard design invariant). The web app
  reaches it over in-container localhost; it is never exposed off-box.
- **State** persists on a host volume `~/meridian-data → /opt/data`
  (`MERIDIAN_STATE_DIR` for the daemon writer, `MERIDIAN_ROOT` for the web
  reader). Survives image rebuilds.
- **Secrets** come from `~/meridian/.env` (chmod 600) via compose `env_file`.

## 4. Requirements

### Functional
- F1. Daemon boots in autonomous mode (`MERIDIAN_AUTONOMOUS=true`) and runs the
  screening + management cron cycles.
- F2. Real on-chain writes armed (`MERIDIAN_WRITE_UNSAFE=true`, `DRY_RUN=false`).
- F3. Dashboard renders live portfolio/positions and can issue control actions
  through the bridge.
- F4. Telegram ops surface connected (optional but recommended): status,
  positions, close, screen, deploy.

### Non-functional
- N1. **Auto-restart** on crash and **auto-start on host boot**
  (`restart: unless-stopped`).
- N2. **State durability** across container recreation and image rebuild.
- N3. **Reachable only over Tailscale for admin**; public surface limited to the
  authenticated dashboard subdomain.
- N4. Fast redeploys (trim the unused C/C++ build toolchain from the image).

### Security
- S1. `.env` is `600`, owned by `nafidinara`; the wallet key never leaves the box
  and is never entered by the AI assistant.
- S2. Bridge is localhost-only; the daemon refuses to bind `0.0.0.0`.
- S3. The public dashboard sits behind **Cloudflare Access** — no unauthenticated
  path to a wallet control panel.
- S4. Live writes gated behind the explicit `MERIDIAN_WRITE_UNSAFE` flag.

## 5. Acceptance criteria

1. `docker compose ps` shows `meridian` **Up**; `pm2 list` inside shows both
   `meridian` and `meridian-web` **online**.
2. Daemon log prints `MERIDIAN_WRITE_UNSAFE=true — real Meteora write paths ARMED`
   and `bridge on 127.0.0.1:8787`.
3. `curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8787/…` (in-container)
   returns state JSON.
4. Dashboard loads at `https://meridian.nafidinara.com` and **requires Cloudflare
   Access login**; after auth it shows live wallet balance + positions.
5. A full screening→deploy or management→close cycle completes on-chain (verified
   in logs + Telegram + on Solana).
6. `docker restart meridian` and a host reboot both bring the stack back
   automatically with state intact.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Live trading loss from a boot-time bug | Health-check window right after live cutover; kill switch = `docker compose stop` / set `DRY_RUN=true` and restart |
| Public dashboard exposes wallet control | Cloudflare Access mandatory before go-live (S3) |
| Flaky vivobook Wi-Fi drops SSH/tunnel | Tailscale + `restart: unless-stopped` + tunnel is outbound-only and self-heals |
| State loss on rebuild | `/opt/data` host volume (N2) |
| Secret leakage | `.env` 600, gitignored, never rsynced (S1) |

## 7. Non-goals

- No migration off the home server to a cloud VPS (revisit only if uptime SLA
  demands it).
- No CI/CD pipeline for auto-deploy (manual rsync + `compose up` for now).
- No multi-instance / HA — single daemon by design (position-lock invariants).
- Discord listener not part of this deployment.

## 8. Rollback / kill switch

```bash
# Stop everything (positions stay open on-chain, daemon just stops managing):
cd ~/meridian && docker compose stop
# Disarm live writes but keep monitoring:
sed -i 's/^MERIDIAN_WRITE_UNSAFE=true/MERIDIAN_WRITE_UNSAFE=false/' .env && docker compose up -d
```
