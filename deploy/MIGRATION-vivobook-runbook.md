# Meridian — Vivobook Migration Runbook

> ⚠️ **HISTORICAL — superseded by [`deploy/homeserver/README.md`](homeserver/README.md).**
> This document describes the retired vivobook / Docker / Cloudflare-Access setup
> (`calisto.nafidinara.com`, GitHub Actions auto-deploy, Sage delegation over
> `sage-api.nafidinara.com`). Meridian now runs on a Windows homeserver as pm2
> processes behind a Cloudflare Tunnel at `au.alieffauzan.com`, with **no CI deploy
> pipeline** and **Sage disabled** (no `SAGE_*` env → local ReAct loop decider).
> Kept for history only. Do not follow these steps against the current box.

> **✅ STATUS: COMPLETED 2026-08-02.** Migration from Tencent HK VPS →
> vivobook home server executed successfully. Sage delegation moved from
> CF-tunneled HTTPS to intra-host docker (`host.docker.internal:8643`).
> Tencent Meridian containers + data scrubbed; Tencent CF Tunnel deleted.
> The VPS itself is retained for other projects. Current live architecture:
> [`OPERATIONS.md`](OPERATIONS.md). This runbook kept as a reference for
> any future host swap.
>
> Ordered executable checklist for moving the LIVE Meridian daemon from
> Tencent HK VPS (`101.32.216.139`) to the vivobook home server, co-located
> with Sage. Companion doc: design at
> `~/.gstack/projects/umarmuhdhor-meridian/nafidinara-dashboard-design-20260801-*.md`.
>
> **Wallet key is the same across hosts.** Only one daemon may hold
> `MERIDIAN_WRITE_UNSAFE=true` at any moment. Getting this wrong = double-spend.

---

## Phase 0 — Pre-flight (no downtime, do at any time)

**On vivobook (SSH: `ssh vivobook-public`):**

```bash
# 0.1 Docker Engine >= 20.10 (needed for host.docker.internal:host-gateway)
docker version --format '{{.Server.Version}}'   # want >= 20.10.0

# 0.2 Confirm Sage stack is up
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'hermes|sage-api-proxy'
# Expect: hermes (Up), sage-api-proxy (Up), hermes-recall (Up)

# 0.3 Confirm hermes gateway is reachable via socat
curl -sSf -H "Authorization: Bearer $(read -s -p 'SAGE_API_KEY: ' K; echo -n "$K")" \
  http://127.0.0.1:8643/v1/models | head -c 200
# Expect: 200 OK + a JSON body (or 401 = wrong key; 000 = socat/hermes down)

# 0.4 Confirm the `web` external network exists (Caddy uses this)
docker network ls | grep -E '^\S+\s+web\s'

# 0.5 Archive stale meridian dirs from the Jul-11 pre-Tencent attempt
mv ~/meridian ~/meridian.old-20260712 2>/dev/null || true
mv ~/meridian-data ~/meridian-data.old-20260712 2>/dev/null || true
mkdir -p ~/meridian ~/meridian-data
```

**Set up SSH keypair for password-less rsync from vivobook to Tencent** (once):
```bash
ssh-keygen -t ed25519 -f ~/.ssh/tencent-rsync -N ""
ssh-copy-id -i ~/.ssh/tencent-rsync.pub ubuntu@101.32.216.139
ssh -i ~/.ssh/tencent-rsync ubuntu@101.32.216.139 'echo ok'  # smoke test
```

**CI/CD path (SSH via Cloudflare Access, ubuntu-latest runner):**

Vivobook has zero open inbound ports; SSH goes through Cloudflare Access
(`cloudflared access ssh --hostname ssh.nafidinara.com`) with a service token.

1. **Deploy keypair** (on your Mac):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/meridian-gh-deploy -N "" -C "meridian-gh-actions"
   ssh-copy-id -i ~/.ssh/meridian-gh-deploy.pub vivobook-public
   ssh -i ~/.ssh/meridian-gh-deploy vivobook-public 'echo OK'   # smoke test
   ```

2. **CF Access service token** (Zero Trust dashboard):
   - Access → Service Auth → Service Tokens → Create Service Token
   - Name: `meridian-github-actions`, duration: 1 year
   - **Copy Client ID + Client Secret immediately** (secret shown only once)
   - Access → Applications → the app protecting `ssh.nafidinara.com` → Policies
     → Add: Action=`Service Auth`, Include=Service Token=`meridian-github-actions`

3. **GitHub repo secrets** (Settings → Secrets → Actions):
   - `CF_ACCESS_CLIENT_ID` — from the service token (ends in `.access`)
   - `CF_ACCESS_CLIENT_SECRET` — from the service token
   - `VIVOBOOK_SSH_KEY` — full contents of `~/.ssh/meridian-gh-deploy` (private half)

4. **On the vivobook** — GHCR pull auth:
   ```bash
   read -s -p 'GHCR PAT (read:packages): ' PAT; echo
   echo "$PAT" | docker login ghcr.io -u umarmuhdhor --password-stdin
   ```

5. **Sanity check the whole path** — run the workflow's SSH bootstrap steps
   locally to confirm everything wires up before the real cutover deploy:
   ```bash
   # Simulate what the ubuntu-latest runner will do:
   cloudflared access ssh --hostname ssh.nafidinara.com < /dev/null 2>&1 | head -3
   ```

**On the merge branch (this):**
- Do all file edits on `feat/vivobook-migration`.
- Do NOT merge to `dashboard` until Phase 3 (cutover).

---

## Phase 1 — Rehearsal (day −1, vivobook up as read-only observer)

Both stacks live simultaneously. Vivobook uses `MERIDIAN_WRITE_UNSAFE=false`
so it observes without trading. Sage session key is different to prevent
memory contamination.

```bash
# 1.1 On Tencent, freeze state briefly
ssh ubuntu@101.32.216.139 'cd ~/meridian && sudo docker compose stop meridian'
# On-chain positions are safe; daemon reconciles from state on boot.

# 1.2 On vivobook, rsync state + config from Tencent
rsync -avz --progress \
  -e "ssh -i ~/.ssh/tencent-rsync" \
  ubuntu@101.32.216.139:~/meridian-data/ ~/meridian-data/
scp -i ~/.ssh/tencent-rsync ubuntu@101.32.216.139:~/meridian/.env ~/meridian/.env.from-tencent
scp -i ~/.ssh/tencent-rsync ubuntu@101.32.216.139:~/meridian/user-config.json ~/meridian/user-config.json

# 1.3 Restart Tencent so it resumes live trading during rehearsal
ssh ubuntu@101.32.216.139 'cd ~/meridian && sudo docker compose start meridian'

# 1.4 Build vivobook's .env from the imported Tencent one, with 5 changes:
#     a) MERIDIAN_WRITE_UNSAFE=false               (read-only observer)
#     b) SAGE_BASE_URL=http://host.docker.internal:8643   (intra-docker)
#     c) SAGE_SESSION_KEY=meridian-trading-rehearsal      (isolate from Tencent's session)
#     d) SAGE_CF_ACCESS_CLIENT_ID / _SECRET        DELETE (no CF Access intra-host)
#     e) CLOUDFLARE_TUNNEL_TOKEN                   REMOVED (no cloudflared container on vivobook)
mv ~/meridian/.env.from-tencent ~/meridian/.env
chmod 600 ~/meridian/.env
sed -i 's|^SAGE_BASE_URL=.*|SAGE_BASE_URL=http://host.docker.internal:8643|' ~/meridian/.env
sed -i 's|^SAGE_SESSION_KEY=.*|SAGE_SESSION_KEY=meridian-trading-rehearsal|' ~/meridian/.env
sed -i '/^SAGE_CF_ACCESS_/d' ~/meridian/.env
sed -i '/^CLOUDFLARE_TUNNEL_TOKEN=/d' ~/meridian/.env
grep -q '^MERIDIAN_WRITE_UNSAFE=' ~/meridian/.env \
  && sed -i 's|^MERIDIAN_WRITE_UNSAFE=.*|MERIDIAN_WRITE_UNSAFE=false|' ~/meridian/.env \
  || echo 'MERIDIAN_WRITE_UNSAFE=false' >> ~/meridian/.env

# 1.5 Regenerate PIN hash + session secret (do NOT copy from Tencent)
openssl rand -hex 32 | sed 's|^|MERIDIAN_SESSION_SECRET=|' >> ~/meridian/.env

# For PIN hash: after containers boot, exec into meridian and run the scrypt cmd
# (see OPERATIONS.md §7). Or pick a fresh PIN here and generate offline.

# Optional: rehearsal-slow config so we don't 2x-load Helius/Jupiter/OpenRouter
# (edit user-config.json screening/management intervals to 30 min)

# 1.6 Sync compose from the feature branch, then boot
cd ~/meridian
git clone https://github.com/umarmuhdhor/meridian.git .repo || true
cd .repo && git fetch origin feat/vivobook-migration && git checkout feat/vivobook-migration && cd ..
cp .repo/docker-compose.yml ~/meridian/docker-compose.yml
cp -r .repo/deploy ~/meridian/deploy
sudo docker compose up -d --build

# 1.7 Verify (spend 24h watching)
sudo docker compose ps                          # meridian + meridian-web Up
sudo docker compose logs -f meridian | grep -E 'wallet|position|sage'
# Look for:
#   ✓ "wallet: <X> SOL ($<Y>)" — matches Tencent balance
#   ✓ N positions loaded — matches state.json count
#   ✓ Sage delegation success on first screening cycle (no "sage delegation failed, falling back")
#   ✗ WRITE_UNSAFE=true anywhere (should be false during rehearsal)

# SSH tunnel + check dashboard
ssh -L 3000:127.0.0.1:3000 vivobook-public
# In another shell: curl -sI http://localhost:3000/login   # want 200 or redirect
```

**Rehearsal exit criteria (24h observation):**
- [ ] Vivobook logs show identical position IDs + PnL to Tencent (write-unsafe difference ignored)
- [ ] Sage delegation success rate on vivobook ≥ 95% over the 24h
- [ ] No unexpected exceptions in `sudo docker compose logs meridian | grep -iE 'error|fatal'`
- [ ] Dashboard reachable via SSH tunnel; login works with regenerated PIN
- [ ] Telegram Calisto posts boot card + status when queried

If any criterion fails → investigate + fix + re-rehearse. Do NOT proceed to cutover.

---

## Phase 2 — Cutover (day 0, ~15 min maintenance window)

**Announce in Telegram group first:** "🛠 15-min maintenance window starting.
Migrating Meridian to vivobook. Positions stay open on-chain."

```bash
# 2.1 Snapshot vivobook's data volume (cheap rollback insurance)
sudo cp -a ~/meridian-data ~/meridian-data.snapshot-$(date +%Y%m%d-%H%M)

# 2.2 Stop Tencent's daemon
ssh ubuntu@101.32.216.139 'cd ~/meridian && sudo docker compose stop'
# Verify positions on-chain unchanged (Solscan or block explorer)

# 2.3 Final delta rsync — Tencent had 24h of new state since rehearsal
rsync -avz --progress --delete \
  -e "ssh -i ~/.ssh/tencent-rsync" \
  ubuntu@101.32.216.139:~/meridian-data/ ~/meridian-data/

# 2.4 Flip vivobook to LIVE
sed -i 's|^MERIDIAN_WRITE_UNSAFE=.*|MERIDIAN_WRITE_UNSAFE=true|' ~/meridian/.env
sed -i 's|^SAGE_SESSION_KEY=.*|SAGE_SESSION_KEY=meridian-trading|' ~/meridian/.env
# Verify
grep -E '^(MERIDIAN_WRITE_UNSAFE|SAGE_SESSION_KEY|SAGE_BASE_URL)' ~/meridian/.env

# 2.5 Recreate the meridian daemon so it picks up the new env
sudo docker compose up -d --force-recreate meridian

# 2.6 Cloudflare Tunnel — repoint calisto.nafidinara.com
# In CF Zero Trust UI:
#   Networks → Tunnels → <vivobook connector> → Public Hostnames:
#     ADD    calisto.nafidinara.com → http://caddy:80 (or whatever your Caddy service is)
#            + Caddyfile entry on vivobook: `calisto.nafidinara.com { reverse_proxy meridian:3000 }`
#     DELETE calisto.nafidinara.com from the Tencent tunnel (meridian-vps)
#     DELETE mrd-bridge.nafidinara.com from the Tencent tunnel (no longer used)
# Access application "Meridian" — no change; policy still applies (repoints automatically).

# 2.7 Verify end-to-end
curl -sI https://calisto.nafidinara.com                # want 302 → CF Access
curl -sI http://127.0.0.1:3000/login                    # want 200 on the box
sudo docker compose logs meridian --tail=100 | grep -E 'wallet|position|WRITE_UNSAFE|sage'

# Wait for one screening cycle. Verify Sage delegation succeeds intra-docker.
# Telegram: Calisto should post a boot card, then a screening cycle card
# within `screeningIntervalMin`.

# 2.8 Merge the migration branch to `dashboard` — this is the FIRST self-hosted-runner CI run
cd <mac local repo>
git checkout dashboard
git merge --no-ff feat/vivobook-migration -m "chore: cutover to vivobook host + GitHub-hosted runner (ubuntu-latest, SSH via CF Access) CI"
git push origin dashboard
# Watch Actions tab. Deploy job runs on ubuntu-latest, tunnels through CF Access.
# deploy.sh should pull the same :dashboard image (already deployed manually
# in 2.5) and no-op the recreate. Health check = 200. Green.
```

**Announce:** "✅ Migration complete. Meridian running on vivobook, Sage co-located, dashboard live."

---

## Phase 3 — Decommission (day 0 + 60 min, after vivobook stable)

```bash
# 3.1 Delete Tencent HK VPS
#   Tencent Cloud console → destroy the 101.32.216.139 instance → confirm.
#   Verify billing stops in the console.

# 3.2 Delete Tencent's Cloudflare Tunnel `meridian-vps`
#   CF Zero Trust → Networks → Tunnels → meridian-vps → Delete.

# 3.3 Delete sage-api.nafidinara.com (only Meridian@Tencent used it)
#   CF Zero Trust → Networks → Tunnels → <vivobook connector> → Public Hostnames
#     → delete sage-api.nafidinara.com
#   CF Zero Trust → Access → Applications → delete the Sage-API app + policy
#   CF DNS → delete sage-api CNAME
#   CF Zero Trust → Access → Service Auth → revoke the SAGE_CF_ACCESS service token

# 3.4 Delete GH repo secrets that are only used by the old SSH-based deploy
#   Repo Settings → Secrets and variables → Actions:
#     VPS_HOST, VPS_USER, VPS_SSH_KEY  → delete

# 3.5 Purge Tencent-only secrets from ~/.ssh on your Mac
#   (keep tencent-rsync key until you've confirmed vivobook is stable for a week)

# 3.6 On vivobook: shred stale files from the pre-Tencent attempt
shred -u ~/meridian.old-20260712/.env ~/meridian.old-20260712/.env.save 2>/dev/null || true
rm -rf ~/meridian.old-20260712 ~/meridian-data.old-20260712

# 3.7 Delete the snapshot from step 2.1 after a week
# rm -rf ~/meridian-data.snapshot-*   # do this in 7 days
```

Update `deploy/OPERATIONS.md` — host, architecture, CI/CD sections now
reflect vivobook. Commit + push to `dashboard`. Self-hosted runner deploys
(should be a `scope=none` docs-only push, no rebuild).

---

## Rollback Plan

- **Rehearsal fails:** `docker compose down` on vivobook; Tencent still armed and untouched.
- **Cutover fails BEFORE step 3.1 (VPS destroy):**
  1. On vivobook: `sudo docker compose stop`
  2. On Tencent: `sudo docker compose start`
  3. CF: re-point `calisto.nafidinara.com` back to Tencent tunnel; re-add `mrd-bridge.nafidinara.com`
  4. Tencent has slightly stale state (from 2.3 delta); daemon reconciles from on-chain positions on boot
- **Post-decommission failure:** No fast rollback. Restore from `~/meridian-data.snapshot-*` on vivobook. If vivobook hardware fails, rebuild fresh on a new host from `~/meridian-data` volume + `.env` backup.

---

## Verification Checklist (paste into Telegram after cutover)

- [ ] `calisto.nafidinara.com` returns 302 → CF Access
- [ ] Login with PIN works
- [ ] Wallet balance matches pre-cutover snapshot
- [ ] Open position count matches Tencent's final state.json
- [ ] First post-cutover screening cycle used Sage (log shows `sage` decider, not `local loop fallback`)
- [ ] PnL poller ticking every 30s in logs
- [ ] Telegram Calisto posted boot card + at least one status message
- [ ] Sage bot responds to a `/status` prompt in Telegram group
- [ ] GH Actions ran green on the merge commit, deploy job used GitHub-hosted runner (ubuntu-latest, SSH via CF Access)
- [ ] `sudo docker compose ps` shows `meridian` + `meridian-web` both Up, no restart loop
