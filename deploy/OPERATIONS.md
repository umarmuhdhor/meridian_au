# Meridian — Operations Manual (A-Z)

> ⚠️ **HISTORICAL — superseded by [`deploy/homeserver/README.md`](homeserver/README.md).**
> This document describes the retired vivobook / Docker / Cloudflare-Access setup
> (`calisto.nafidinara.com`, GitHub Actions auto-deploy, Sage delegation over
> `sage-api.nafidinara.com`). Meridian now runs on a Windows homeserver as pm2
> processes behind a Cloudflare Tunnel at `au.alieffauzan.com`, with **no CI deploy
> pipeline** and **Sage disabled** (no `SAGE_*` env → local ReAct loop decider).
> Kept for history only. Do not follow these steps against the current box.

> **Was the canonical source of truth for the vivobook era.** If anything here
> disagrees with an older doc (`PRD-deployment.md`, `PLAN-deployment.md`), this
> file wins — but all three are superseded by `deploy/homeserver/README.md`. Last major update: 2026-08-01
> (Tencent HK → vivobook migration; co-located with Sage).

---

## 0. Current state at a glance

| | |
|---|---|
| **Live code** | TypeScript rewrite under `src/` (entry `src/entrypoints/daemon.ts` → `dist/entrypoints/daemon.js`). The legacy JS layout in `CLAUDE.md` is retired. |
| **Branch** | `dashboard` (this is the deployed branch, not `main`) |
| **Host** | vivobook home server (co-located with Sage), SSH `ssh vivobook-public`, user `nafidinara`, Ubuntu |
| **App dir** | `~/meridian` · state volume `~/meridian-data` → `/opt/data` |
| **Runtime** | Docker: `meridian`, `meridian-web` (2 containers). Reverse proxy = vivobook's shared `caddy` + `cloudflared` (already running for other services). `docker compose` (no sudo needed; user in `docker` group). |
| **Trading** | LIVE — real wallet, `DRY_RUN=false`, `MERIDIAN_WRITE_UNSAFE=true` |
| **Screening decider** | **Sage** (Hermes agent on same host), `MERIDIAN_DECIDER=sage`, intra-docker delegation via `host.docker.internal:8643` → `sage-api-proxy` (socat) → `hermes:8642`. Local LLM loop is the fallback. |
| **Entry gate** | `maxFromHighPct` (default 35) — trend-independent drawdown veto in screening; rejects candidates >35% below window high on any TF. Added 2026-08-29. |
| **Exit engine** | Smart-exit regime engine (`smartExitEnabled`) — CATASTROPHIC/DYING/HEALTHY/AMBIGUOUS classifier replacing the static stop; AMBIGUOUS escalates to Sage (`sageExitEnabled`, advisory CLOSE/HOLD). **Dark by default**; armed via dashboard Config → Exit rules. Design: [`SPEC-2026-08-29-smart-exit-regime-engine.md`](SPEC-2026-08-29-smart-exit-regime-engine.md). |
| **Telegram** | Single bot: **@SageHermesAnd_bot** posts BOTH Sage's replies AND Meridian's deploy/close cards. Meridian's `TELEGRAM_BOT_TOKEN` = Sage's bot token (swapped 2026-08-02 — Calisto bot retired). `MERIDIAN_TELEGRAM_INBOUND=false` so only Hermes polls the token (avoids `getUpdates` 409). |
| **Dashboard** | https://calisto.nafidinara.com (Cloudflare Access + 6-digit PIN) |
| **Deploy** | push to `dashboard` → GitHub Actions (`ubuntu-latest`) → GHCR + `scp`/`ssh` to vivobook over Cloudflare Access SSH → `deploy.sh` |
| **Registry** | `ghcr.io/umarmuhdhor/meridian` (private) |
| **Kill switch** | `cd ~/meridian && docker compose stop` |

---

## 1. Architecture

```
                        ┌──── GitHub (umarmuhdhor/meridian) ────┐
  git push dashboard ──►│ Actions (ubuntu-latest):              │
                        │   test-build → push image             │
                        │   deploy: cloudflared access ssh      │
                        │     → scp/ssh vivobook → deploy.sh    │
                        └──────────────┬────────────────────────┘
                                       │ ghcr.io/…:<sha>
                                       ▼
  Browser ── https://calisto.nafidinara.com      vivobook home server (ssh vivobook-public)
     │                                            ~/meridian (docker compose)
     ▼                                            ┌──────────────────────────────────────────┐
  Cloudflare edge ── TLS + Access (email OTP) ───►│ (existing vivobook cloudflared) → caddy  │
     │ (GATE 1: identity)                         │        │                                  │
     ▼                                            │        ▼                                  │
  cloudflared tunnel (outbound-only)              │  caddy (Host→backend routing on `web` net)│
                                                  │        │                                  │
                                                  │        ▼                                  │
                                                  │  meridian (daemon)  ── netns + bridge     │
                                                  │    127.0.0.1:8787 + state vol             │
                                                  │        ▲ network_mode: service            │
                                                  │  meridian-web (Next.js :3000)             │
                                                  │    GATE 2: PIN middleware                 │
                                                  └──────────┬───────────────────────────────┘
                                                             │
                                          daemon → Solana wallet (LIVE)
                                             │
                                             │ Sage delegation (intra-host)
                                             ▼
                                    host.docker.internal:8643
                                             │ (docker host-gateway)
                                             ▼
                                    sage-api-proxy (socat) → hermes:8642
                                    (OpenAI-compatible API, session-key auth)
```

**Two containers, one image.** Both run `ghcr.io/umarmuhdhor/meridian:dashboard`,
selecting one PM2 app via `--only`:

- **`meridian`** — the trading daemon. Owns the Docker network namespace, the
  control bridge on `127.0.0.1:8787` (localhost-only, never exposed), and the
  state volume. Joins the `web` external network so vivobook's Caddy reaches it
  by container DNS (`meridian:3000`). `extra_hosts: host.docker.internal:host-gateway`
  lets it hit Sage's socat proxy on the host. Restarts only when daemon/core code changes.
- **`meridian-web`** — the Next.js dashboard. Uses `network_mode: "service:meridian"`
  to share the daemon's namespace so it can reach the localhost bridge and listen
  on `:3000` there. Redeploys with **zero daemon interruption**.
- **cloudflared + Caddy** live on vivobook already, serving other services too.
  This repo doesn't manage them. A Caddyfile entry + CF Tunnel public hostname
  point `calisto.nafidinara.com` → `meridian:3000`. See §4 for setup.
- **sage-api-proxy + hermes** live in the Sage stack (`~/.hermes/hermes-agent/`).
  This repo doesn't manage them either. Meridian only consumes the socat endpoint
  at `host.docker.internal:8643`.
- **`bridge-proxy`** (socat, in meridian's netns) exposes the bridge on
  `127.0.0.1:8788` on the vivobook host, so the Sage Hermes plugin (running in
  the host-net `hermes` container) can call Meridian's `/tool` endpoint via
  `MERIDIAN_BRIDGE_URL=http://127.0.0.1:8788`. Meridian → Sage (delegation) +
  Sage → Meridian (tool invocation) both work; the tool-invocation direction
  needs this sidecar because the bridge itself binds `127.0.0.1` inside
  meridian's netns for defence-in-depth.

Why split meridian ↔ meridian-web: a dashboard change should not restart a live
trading daemon.

**What migrated away (deleted in the vivobook cutover):**
- `meridian-bridge-proxy` sidecar (socat) — no longer needed; Meridian reaches
  Sage directly intra-host, not the other way around.
- `mrd-bridge.nafidinara.com` Cloudflare Tunnel route — same reason.
- `sage-api.nafidinara.com` — Sage's external CF-tunneled endpoint; was only
  used by Tencent-Meridian; now intra-docker.
- Per-request `SAGE_CF_ACCESS_CLIENT_ID` / `_SECRET` headers — intra-host, no CF Access.
- Repo `cloudflared` container — vivobook has its own for all services.

---

## 2. Access

- **SSH:** `ssh vivobook-public` (user `nafidinara`, in `docker` group — no sudo needed for `docker` commands).
- **Dashboard (public):** https://calisto.nafidinara.com → Cloudflare Access
  (email one-time PIN) → 6-digit app PIN.
- **Dashboard (admin, no CF):** SSH tunnel — `ssh -L 3000:127.0.0.1:3000 vivobook-public`
  then http://localhost:3000 (still PIN-gated).
- **Historical:** Tencent HK VPS (`101.32.216.139`) was decommissioned during
  the 2026-08-01 migration. Runbook + rollback: [`MIGRATION-vivobook-runbook.md`](MIGRATION-vivobook-runbook.md).

---

## 3. The deploy pipeline

**Trigger:** any push to `dashboard`.

```
push → .github/workflows/deploy-dashboard.yml
  test-build job (ubuntu-latest):
    1. Daemon tests (npm ci + npm test = typecheck + vitest)         red → STOP
    2. Web tests    (dashboard/web: npm ci + npm test + build)       red → STOP
    3. Scope decision  docs-only → skip;  web/** only → web-only;  else → full
    4. Build + push    ghcr.io/…:<sha> + :dashboard  (buildx + gha cache)
  deploy job (self-hosted, vivobook)  — guarded: push+dashboard only:
    5. Checkout on runner
    6. cp docker-compose.yml + deploy/deploy.sh → ~/meridian/
    7. cd ~/meridian && ./deploy/deploy.sh <sha> <scope>
```

The deploy job runs on `ubuntu-latest` (GitHub-hosted). Vivobook has zero
open inbound ports — the runner reaches it through **Cloudflare Access SSH**:
`cloudflared access ssh --hostname ssh.nafidinara.com` authenticated with a
service token (`CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` GH secrets),
tunneled to the vivobook's sshd, deploy keypair (`VIVOBOOK_SSH_KEY`) does the
final auth. Deploy is `push:[dashboard]` only (an `if:` guard prevents
accidental `pull_request` invocation from exposing secrets to fork PRs).

**`deploy/deploy.sh` on the box:**
```
tag :dashboard → :previous          (rollback point)
pull :<sha> → tag :<sha> → :dashboard
cutover (--force-recreate):
    web-only → up -d --no-deps meridian-web     (daemon keeps trading)
    full     → up -d                             (daemon + web, ~15s reconciled gap)
health-check ≤ 60s:
    daemon container up (not crash-looping) + PM2 online + web /login = 200
    healthy   → done (prune old images)
    unhealthy → retag :previous → :dashboard → up -d (same scope) → exit 1
```

- **Serialized:** a `concurrency` group means two pushes never race the box.
- **Deploy gated on secrets:** the deploy steps skip (run stays green) until the
  GitHub secrets exist — see §4.
- **Scopes:** `docs-only` skips build+deploy entirely (no daemon restart for a
  README change); `web-only` = seamless; `full` = daemon restart.

### Manual deploy (bypass CI)
```bash
ssh vivobook-public
cd ~/meridian
docker login ghcr.io -u umarmuhdhor               # if not already
./deploy/deploy.sh <sha> full                     # or web-only
# dry-run first: ./deploy/deploy.sh <sha> full --dry-run
```

---

## 4. First-time setup (already done — here for rebuilds / new maintainers)

**Deploy keypair** (on your Mac):
```bash
ssh-keygen -t ed25519 -f ~/.ssh/meridian-gh-deploy -N "" -C "meridian-gh-actions"
ssh-copy-id -i ~/.ssh/meridian-gh-deploy.pub vivobook-public
```

**CF Access service token** (Zero Trust → Access → Service Auth → Service Tokens):
1. Create token `meridian-github-actions`, save Client ID + Secret (secret shown once).
2. Attach to the Access application protecting `ssh.nafidinara.com`: add a
   policy with Action=`Service Auth`, Include=Service Token=`meridian-github-actions`.

**GitHub repo secrets** (Settings → Secrets → Actions):
| Secret | Value |
|---|---|
| `CF_ACCESS_CLIENT_ID` | from the service token above (ends in `.access`) |
| `CF_ACCESS_CLIENT_SECRET` | from the service token above |
| `VIVOBOOK_SSH_KEY` | contents of `~/.ssh/meridian-gh-deploy` (the private half) |

GHCR push uses `GITHUB_TOKEN` (built-in, no secret needed).

**On the vivobook (one-time)** — GHCR pull auth:
```bash
echo "<GITHUB_PAT_with_read:packages>" | docker login ghcr.io -u umarmuhdhor --password-stdin
```

**Cloudflare** (dashboard exposure — reuses vivobook's existing connector):
- Zero Trust → Networks → Tunnels → `<vivobook connector>` → Public Hostname
  `calisto.nafidinara.com` → `http://caddy:80` (or the Caddy service on
  vivobook's `web` network).
- Add Caddyfile entry on vivobook (outside this repo):
  `calisto.nafidinara.com { reverse_proxy meridian:3000 }`.
- Zero Trust → Access → Applications → `Meridian` (domain `calisto.nafidinara.com`),
  policy Allow → Emails (your address + teammates).
- Zero Trust → Integrations → Identity providers → **One-time PIN** enabled;
  app Authentication → "Accept all available identity providers" (so teammates
  without a Cloudflare account get an email code).

---

## 5. Secrets & env (`~/meridian/.env`, chmod 600, gitignored)

| Key | Purpose |
|---|---|
| `WALLET_PRIVATE_KEY` | base58 Solana key (JSON array also accepted). NOT base64. |
| `RPC_URL` | mainnet RPC (Helius). Wallet balance uses `getBalance` on this. |
| `OPENROUTER_API_KEY` | LLM. Model set per-role in `user-config.json`. |
| `DASHBOARD_TOKEN` / `BRIDGE_TOKEN` | same value; the daemon↔web bridge token. |
| `MERIDIAN_DASHBOARD_PIN_HASH` | `salt:scryptHash` of the dashboard PIN (see §7). |
| `MERIDIAN_SESSION_SECRET` | 32-byte hex, signs the dashboard session cookie. |
| `DRY_RUN` / `MERIDIAN_WRITE_UNSAFE` | live gates: `false` / `true`. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | **Sage's bot token** (@SageHermesAnd_bot) + group ID. Same token Hermes uses — Meridian only posts outbound cards, Hermes handles inbound. Calisto bot retired 2026-08-02; backups at `~/meridian/.env.bak-sagebot-*`. |
| `MERIDIAN_TELEGRAM_INBOUND` | **must be `false`** now that the token is shared with Hermes — two processes on `getUpdates` = 409 Conflict. |
| `MERIDIAN_DECIDER=sage` + `SAGE_BASE_URL=http://host.docker.internal:8643` + `SAGE_API_KEY` / `SAGE_SESSION_KEY=meridian-trading` / `SAGE_TIMEOUT_MS=90000` | Path 2 Sage delegation, intra-host. `SAGE_CF_ACCESS_*` no longer used (removed at migration). Set as compose `environment` defaults on 2026-08-02, so a fresh `.env` alone is enough. |
| `HELIUS_API_KEY` | **unused in the TS rewrite** (leftover); safe to leave blank. |

Adapter selection lives in `docker-compose.yml` env, not `.env`:
`MERIDIAN_CHAIN=meteora` (→ cascades `MERIDIAN_MARKET=real`, `MERIDIAN_PRICE=jupiter`).
**`DRY_RUN=false` alone is not enough — without `MERIDIAN_CHAIN=meteora` the daemon
boots demo adapters (fake market, static $150 price).**

> `.env` never leaves the box and is never committed. Do not paste the wallet key
> into chat. Quotes around values break things — `sudo docker compose env_file`
> passes them literally (Next.js then sees `"salt:hash"` and login fails).

---

## 6. Config management (`~/meridian/user-config.json`)

- Flat trading params (thresholds, sizing, intervals, per-role models). Loaded at
  boot; mounted into the container at `/app/user-config.json`.
- **Gotcha — the inode trap:** it's a single-file bind mount. A host-side edit that
  writes-new-then-renames (most editors, `rsync`, `scp`, `python json.dump`+`os.replace`)
  SWAPS the inode, so the running container keeps the OLD file until recreate. For a
  MANUAL host edit apply with `docker compose up -d --force-recreate meridian`, OR edit
  in place (`python -c` that opens the same file `"w"` / truncates), OR go through the
  dashboard.
- **Dashboard saves persist correctly (fixed 2026-08-29).** `update_config` (dashboard
  Config page, Telegram `/set`) writes with `writeJsonAtomic {inPlace:true}` — it
  overwrites the existing inode (copyFile O_TRUNC), so the change hits the host file AND
  live-reloads the daemon with no restart. Before the fix, saves silently reverted:
  temp+rename created a detached inode inside the container (in-memory updated, host file
  unchanged, reverted on next restart, `meridian-web` showed stale). If a config save ever
  appears not to stick again, verify container-vs-host with
  `docker exec meridian stat -c %i /app/user-config.json` vs
  `stat -c %i ~/meridian/user-config.json` (must be EQUAL). See CLAUDE.md § Known issues.
- **Schema caveats (deployed branch):** `strategy` must be `spot`|`curve`|`bid_ask`
  (no `auto`); model fields must be exact OpenRouter slugs, e.g.
  `minimax/minimax-m2.7`. Newer configs (`strategy:"auto"`, opportunity-poll) need
  a newer Meridian version and will fail schema validation → crash-loop.

---

## 7. Dashboard auth (PIN + Cloudflare Access)

Two independent gates in front of the wallet control panel:

1. **Cloudflare Access** (edge) — email OTP; only allow-listed emails pass.
   Add teammates: Access → Applications → Meridian → Policies → Include → Emails.
2. **6-digit PIN** (app) — Next.js middleware (`dashboard/web/middleware.ts`) +
   `iron-session` cookie; scrypt + constant-time compare; per-IP lockout
   (5 tries / 15 min). Logout button top-right.

**Generate / rotate the PIN hash** (run on the VPS; PIN never stored plaintext):
```bash
read -s -p "PIN: " PIN; echo
sudo docker exec -e PIN="$PIN" meridian node -e \
 'const c=require("crypto");const s=c.randomBytes(16).toString("hex");console.log("MERIDIAN_DASHBOARD_PIN_HASH="+s+":"+c.scryptSync(process.env.PIN,s,64).toString("hex"))'; unset PIN
# paste the line into ~/meridian/.env, then:
sudo docker compose up -d --force-recreate meridian-web
```
`MERIDIAN_SESSION_SECRET`: `openssl rand -hex 32`.

The PIN is **shared** across all Access-allowed users. Cloudflare's Access log
(Zero Trust → Logs) shows who authenticated.

---

## 8. Runbook

```bash
ssh vivobook-public && cd ~/meridian
docker compose ps                          # container status
docker compose logs -f meridian            # daemon logs
docker compose logs -f meridian-web        # dashboard logs
docker exec meridian pm2 list              # process status
docker compose restart meridian-web        # bounce web only
docker compose up -d --force-recreate meridian   # reload daemon (config change)
docker compose stop                        # KILL SWITCH (positions stay open on-chain)
docker compose up -d                       # bring everything back
```
Health probe (what deploy.sh checks): daemon container up + PM2 online + web
`/login` returns 200. Public reachability: `curl -sI https://calisto.nafidinara.com`
should be `302` (redirect into Access).

---

## 9. Troubleshooting (every gotcha this project has hit)

| Symptom | Cause / fix |
|---|---|
| Daemon crash-loop `Directory import … @coral-xyz/anchor … not supported` or `does not provide an export named 'BN'` | Node 22 + `@meteora-ag/dlmm`. Needs `scripts/patch-anchor.js` (wired as `postinstall`). If missing, restore it. |
| `wallet: X SOL ($150)`, `market: fake`, `chain: dryrun` | `MERIDIAN_CHAIN=meteora` not set → demo adapters. It's in compose env. |
| `jupiter-price: all attempts failed → fallback $150` | v6 endpoint sunset. Code uses `lite-api.jup.ag/price/v3` (flat `{mint:{usdPrice}}`). |
| `wallet secret: base58 decode failed` at boot | `WALLET_PRIVATE_KEY` is base64/truncated. Must be base58 (~87-88 chars) or a JSON byte-array. |
| Login always fails / `server not configured` | `.env` value wrapped in quotes (compose passes them literally), or `MERIDIAN_DASHBOARD_PIN_HASH`/`MERIDIAN_SESSION_SECRET` missing. Strip quotes. |
| `Failed to load user-config.json: parse` crash-loop | Schema rejected the config (e.g. `strategy:"auto"`). See §6. Restore a backup from `~/meridian-data/user-config.backup.*.json`. |
| Config edit didn't take effect (MANUAL host edit) | Single-file mount inode trap. `up -d --force-recreate meridian`, or edit in place. See §6. |
| Dashboard/Telegram config save reverts (persisted true → shows false after restart) | Was the bind-mount rename→detached-inode bug; fixed 2026-08-29 (`update_config` writes `{inPlace:true}`). If it recurs, the write is renaming again — check container-vs-host inode are EQUAL (`docker exec meridian stat -c %i /app/user-config.json` vs `stat -c %i ~/meridian/user-config.json`). |
| CI deploy fails: `docker pull … error from registry: denied` (build/test job SUCCEEDED) | vivobook's `ghcr.io` login expired; on overlayfs docker sends the bad token and the registry answers `denied` instead of anon-pulling. The package is public. Fix on the box: `docker logout ghcr.io`, then re-run the failed job: `gh run rerun <run-id> --failed`. |
| Cloudflare "That account does not have access" | The login email isn't in the Access policy. Add it, or enable One-time PIN. |
| Browser shows red "Dangerous" | Chrome Enhanced Safe Browsing false positive on a new domain + login form (not on Google's blocklist — transparency report shows "no available data"). Standard Protection users don't see it. |
| Deploy didn't recreate the container | `docker compose up` skips recreate on a repointed tag — deploy.sh uses `--force-recreate`. |
| `MERIDIAN_IMAGE`/`MERIDIAN_REG` override ignored | `sudo docker compose` strips env without `-E`. Only relevant for local-registry testing. |
| Screening always logs `sage delegation failed, falling back` | `hermes` container down or `sage-api-proxy` (socat) not listening. Check `docker ps \| grep -E 'hermes\|sage-api-proxy'` — both should be Up. `curl -sSf http://127.0.0.1:8643/v1/models -H "Authorization: Bearer $SAGE_API_KEY"` on the host verifies socat→hermes. First screening cycle after a host reboot may briefly show this while hermes finishes booting — expected. Trading continues on the local loop meanwhile. |
| `SAGE_BASE_URL` connection refused inside Meridian container | `extra_hosts: host.docker.internal:host-gateway` missing (needs Docker Engine ≥20.10) or hermes/socat not on the host. `docker exec meridian getent hosts host.docker.internal` should resolve to the docker bridge gateway IP. |
| Sage silent in Telegram group | Check `allowed_chats` in `~/.hermes/profiles/sage/config.yaml` + BotFather `/setprivacy`. Confirm hermes is up. |
| No deploy/close cards posting | Meridian's `TELEGRAM_BOT_TOKEN` must equal Sage's (`~/.hermes/profiles/sage/.env`). Verify: `docker exec meridian env \| grep TELEGRAM_BOT_TOKEN`. |
| Duplicate replies / bot `getUpdates` 409 in logs | Two processes polling same token. `MERIDIAN_TELEGRAM_INBOUND` must be `false` (only Hermes polls). |
| `mrd_close_position` fails via Sage; Sage says "close via direct bridge fallback" | Plugin `mrd_close_position` schema must declare `reason` as required (Meridian `close_position` tool Zod-rejects without it). Fixed 2026-08-02. Ensure `~/.hermes/profiles/sage/plugins/meridian/tools.py` matches the repo copy at `deploy/hermes-meridian-plugin/tools.py`. |
| Dashboard summary shows stale "open" positions (much higher than on-chain) | state.json ghost accumulation — position-repo wasn't flipped on close. Fixed 2026-08-02: `markClosedInRepoHook` on `close_position` + reverse reconciler in management cycle. Existing ghosts auto-flip on the next management tick (~10 min). |
| Sage's terminal can't find `gmgn-cli` (or any tool in `~/.local/bin`) | Sage's HOME resolves to `/opt/data/profiles/sage/home` but `~/.local/bin` isn't on the default PATH. Fix on vivobook: `echo 'export PATH="$HOME/.local/bin:$PATH"' > ~/.hermes/profiles/sage/home/.bashrc` (auto_source_bashrc is on in Sage's config.yaml, so future shells pick it up). |
| Sage doesn't know how to operate Meridian | The `meridian-ops` skill must be installed at `~/.hermes/profiles/sage/skills/meridian-ops/SKILL.md` (source of truth: `deploy/hermes-meridian-plugin/skill/SKILL.md`). Verify with `ls ~/.hermes/profiles/sage/skills/meridian-ops/`; scp + `s6-svc -r gateway-sage` if missing. **Pull the live copy DOWN before editing — Sage self-edits it** (see the plugin README's install/update block). SOUL.md carries small Meridian blocks (deploy payload + exit-advisor role, added 2026-08-29) but detailed ops live in the skill. |
| Sage calls a tool (or rambles) instead of replying `CLOSE:`/`HOLD:` on an exit escalation | Its `meridian-ops` skill/SOUL is stale — the "Autonomous EXIT advising" section (2026-08-29) defines the one-line, no-tool contract. Re-sync SKILL.md + SOUL.md and `s6-svc -r gateway-sage`. The per-request prompt is `EXIT_ADVISOR_PROMPT` in `src/app/management/cycle.ts`; the endpoint is only hit when `sageExitEnabled=true`. |

---

## 10. Rollback & recovery

- **Automatic:** deploy.sh health-checks every release and retags `:previous` →
  `:dashboard` + recreates (same scope) if unhealthy. A bad push never leaves
  trading down.
- **Manual rollback:** `docker tag ghcr.io/umarmuhdhor/meridian:previous
  ghcr.io/umarmuhdhor/meridian:dashboard && docker compose up -d --force-recreate`.
- **State is safe across restarts:** all JSON state persists on `~/meridian-data`
  (`/opt/data` volume); the daemon reconciles open positions on boot.
- **Disarm without stopping:** set `MERIDIAN_WRITE_UNSAFE=false` in `.env` +
  `up -d --force-recreate meridian` — keeps monitoring, blocks new chain writes.

---

## 11. Repo map (deployment-relevant files)

| Path | What |
|---|---|
| `.github/workflows/deploy-dashboard.yml` | the CI/CD pipeline (both jobs on `ubuntu-latest`; deploy job SSHes to vivobook via Cloudflare Access) |
| `deploy/deploy.sh` | on-box pull → cutover → health-check → rollback (unchanged from Tencent era; runs on vivobook via SCP+SSH from the deploy job) |
| `docker-compose.yml` | production stack: meridian, meridian-web (2 containers). Reverse-proxy = vivobook's shared caddy + cloudflared. |
| `deploy/MIGRATION-vivobook-runbook.md` | ordered runbook for the 2026-08-01 Tencent→vivobook migration (rehearsal, cutover, decommission, rollback) |
| `deploy/SAGE-MERIDIAN-ROLLOUT.md` | **Historical** — Path 2 (Sage decider) via CF Tunnel; superseded by intra-host path in this migration. Kept for git-blame context. |
| `deploy/cf-setup-path2.sh` | **Historical** — CF setup for the Tencent-era Sage transport. Not needed on vivobook. |
| `deploy/hermes-meridian-plugin/` | the Hermes `meridian` plugin (source of truth; installed on vivobook Sage profile) |
| `Dockerfile` | node:22 image; `postinstall` runs `patch-anchor.js` |
| `ecosystem.config.cjs` | PM2 apps `meridian` + `meridian-web` (selected via `--only`) |
| `dashboard/web/` | the Next.js dashboard (auth in `middleware.ts`, `lib/auth-core.ts`) |
| `deploy/PRD-deployment.md`, `PLAN-deployment.md` | **historical** (original vivobook design) — see the note at their top |
