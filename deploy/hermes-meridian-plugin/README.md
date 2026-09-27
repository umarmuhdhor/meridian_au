# Hermes `meridian` plugin

Connects **Sage** (a Hermes agent) to the **Meridian** DLMM trading daemon so Sage can
read state and (on request or when delegated) deploy/close/claim via Meridian's
dashboard bridge. This directory is the **source of truth**; the deployed copy lives on
the Sage host at `~/.hermes/profiles/sage/plugins/meridian/`.

## Files
- `plugin.yaml` — manifest (`kind: backend`, 13 `provides_tools`).
- `__init__.py` — `register(ctx)`; registers the 13 tools into the `meridian` toolset. **Relative imports** (`from .tools`) — required for user-dir plugins.
- `tools.py` — tool schemas + handlers.
  - **Reads:** `mrd_get_positions/summary/wallet/candidates/config/performance/decisions/pool_kline`.
  - **Writes (`confirm:true`):** `mrd_deploy_position` (carries `cycle_id`), `mrd_close_position` (**requires `reason` string** — Zod-min:1 on Meridian side), `mrd_claim_fees`, `mrd_update_config` (flat-key patch, live-reloaded, human-gated at the bridge), `mrd_add_lesson` (PREFER/AVOID rule, auto-injected into future screening cycles).
  - **Retrospective trio:** `mrd_get_performance` + `mrd_get_decisions` + `mrd_add_lesson` power the Telegram flow *"we had N losses in a row — analyze and save a lesson"*. Saved lessons appear in Meridian's LESSONS block on the next screening cycle (pinned always; recent 5 unpinned).
  - **Technical analysis:** `mrd_get_pool_kline` returns OHLCV + computed features (spike, at_local_top, atr, vol_spike, trend, support proximity + touches) for a Meteora pool. Multi-timeframe. Screening pre-fetches the same features inline so Sage doesn't need to call this inside a cycle — use it interactively (post-mortems, "was that entry at a spike top?", sanity-check a candidate).
- `client.py` — stdlib (urllib) HTTP client to the bridge. Sends Bearer + explicit User-Agent. Post-migration (2026-08-02) the bridge is intra-host; `MERIDIAN_BRIDGE_CF_CLIENT_ID/SECRET` are unused (kept in client for compat but leave unset). Reads `MERIDIAN_BRIDGE_URL/TOKEN`.
- `test_client.py` — local client tests (`python3 test_client.py`, no Hermes runtime needed).
- `skill/SKILL.md` — Sage's `meridian-ops` operational knowledge skill (mode detection, tool inventory, playbooks, boundaries, spike-top veto, strategy-selection matrix). Deployed to `~/.hermes/profiles/sage/skills/meridian-ops/SKILL.md`. **Sage's SOUL.md is intentionally NOT modified — this skill loads on demand.** **Sage self-edits this file** via its Hermes `skills` toolset — always `scp` the deployed copy BACK to this repo before overwriting from local (see § Sage self-edits below).
- `skill/references/` — deeper knowledge files Sage authored during retrospectives (e.g. `stop-loss-postmortem-aug-2026.md`, `gmgn-setup-and-screening-lessons.md`). Loaded lazily by the skill on demand. Same pull-before-push rule applies.

## Install / update

Pull Sage's latest self-edits FIRST (so you don't clobber them), then push the merged copy back
(`<sage-host>` = wherever Hermes runs):
```
# 1. Pull Sage's live skill + references into this repo
scp <sage-host>:~/.hermes/profiles/sage/skills/meridian-ops/SKILL.md \
    deploy/hermes-meridian-plugin/skill/SKILL.md
scp <sage-host>:'~/.hermes/profiles/sage/skills/meridian-ops/references/*.md' \
    deploy/hermes-meridian-plugin/skill/references/

# 2. Review the diff, commit, then push everything back
git diff deploy/hermes-meridian-plugin/skill/
scp deploy/hermes-meridian-plugin/{plugin.yaml,__init__.py,client.py,tools.py} \
    <sage-host>:~/.hermes/profiles/sage/plugins/meridian/
scp deploy/hermes-meridian-plugin/skill/SKILL.md \
    <sage-host>:~/.hermes/profiles/sage/skills/meridian-ops/SKILL.md
scp deploy/hermes-meridian-plugin/skill/references/*.md \
    <sage-host>:~/.hermes/profiles/sage/skills/meridian-ops/references/
docker exec hermes /command/s6-svc -r /run/service/gateway-sage   # reload sage only
```
Requires in `sage/config.yaml`: `toolsets: [hermes-cli, meridian]` and `plugins: { enabled: [meridian] }`.

## Bridge env

Meridian's dashboard bridge listens on `127.0.0.1:8787` (`DASHBOARD_PORT`). Point
the plugin at an address that reaches it from the Sage host:

```
# ~/.hermes/profiles/sage/config.yaml  (or wherever env is set for sage)
MERIDIAN_BRIDGE_URL=http://127.0.0.1:8787
MERIDIAN_BRIDGE_TOKEN=<same value as DASHBOARD_TOKEN/BRIDGE_TOKEN in Meridian's .env>
# MERIDIAN_BRIDGE_CF_CLIENT_ID=   # only if the bridge sits behind Cloudflare Access
# MERIDIAN_BRIDGE_CF_CLIENT_SECRET=
```

Verify:
```
curl -sSf -H "Authorization: Bearer $MERIDIAN_BRIDGE_TOKEN" \
  "$MERIDIAN_BRIDGE_URL/health"
```

## Notes
- Writes go through the bridge `/tool` path → all of Meridian's safety gates + post-hooks (decision log + Telegram card + auto-swap + repo mark-closed) still fire.
- `mrd_update_config` is **hard-gated at the bridge**: `POST /tool` with `name=update_config` + any `cycle_id` → 403 (`human-gated`). Screening delegations always carry `cycle_id`; user chats never do. The plugin schema's description reinforces this ("only when the human user in the CURRENT conversation has EXPLICITLY asked"), but the code gate is authoritative — do not rely on prompt alone.

## Sage self-edits

Sage has the Hermes `skills` toolset enabled and periodically patches its own `meridian-ops` SKILL.md + writes new `references/*.md` files after retrospectives (e.g. it added `stop-loss-postmortem-aug-2026.md` covering the 6-SL / 2-failure-mode analysis on 2026-08-10). Those edits live on the Sage host first; the repo copy is downstream. **Before any `scp` upload to `~/.hermes/profiles/sage/skills/meridian-ops/`, pull the live version down first** (the Install/update block above does this in order). Otherwise your local push clobbers Sage's learnings.

Also: Sage's saved lessons flow through `mrd_add_lesson` → bridge → Meridian's `add_lesson` tool → `lessons.json`. The `<` and `>` characters are preserved verbatim in the rule text (fixed 2026-08-10; they had been stripped by an HTML-safety regex that made no sense for LLM-prompt content).
