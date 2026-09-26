# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

> **Audience**: future agents/sessions that need to make non-trivial changes
> (add a tool, change a safety rule, fix a cron race, extend a state file)
> without re-reading the whole repo. The README stays user-facing; this
> file is the engineering manual for the **TypeScript codebase under `src/`**.

---

## ⚠️ Read first

1. **Live code = the TypeScript rewrite under `src/`.** Entry point
   `src/entrypoints/daemon.ts` → built to `dist/entrypoints/daemon.js`. There is
   **no** `index.js` / `agent.js` / `tools/*.js` / `persistence/*.js` — the legacy
   JS was retired (`legacy-js` git tag). Architecture is **hexagonal**:
   `domain` (pure) → `ports` (interfaces) → `adapters` (implementations) →
   `app` (use-cases) → `entrypoints` (DI wiring).
2. **Meridian is deployed and trading live.** Two **pm2** processes (`meridian`
   daemon + `meridian-web` Next.js) on a **Windows homeserver** — native Node, no
   Docker, no Caddy. Exposed through an outbound-only Cloudflare Tunnel
   (`cloudflared` Windows service) at **`au.alieffauzan.com`**, gated by a 6-digit
   PIN (and optionally Cloudflare Access at the edge). Deploys are manual
   (`git pull` + build + `pm2 restart`) — there is no CI deploy pipeline.
   **All deploy/ops details live in
   [`deploy/homeserver/README.md`](deploy/homeserver/README.md)** — this file is
   code internals only.
   > **Historical:** the earlier vivobook / Docker / `calisto.nafidinara.com` setup
   > is described in [`deploy/OPERATIONS.md`](deploy/OPERATIONS.md) and
   > [`deploy/MIGRATION-vivobook-runbook.md`](deploy/MIGRATION-vivobook-runbook.md).
   > Those are **superseded** — read them for history, not for how the box runs today.

---

## TL;DR

- **What it is**: Node 22+ ESM service running an LLM-driven ReAct loop
  (OpenAI-compatible) to screen Meteora DLMM pools, deploy SOL into positions,
  monitor them, and close them without a human in the loop. Telegram is the ops
  surface; a Next.js dashboard (behind the localhost bridge) is the web surface;
  Agent Meridian HiveMind provides shared learning.
- **Entry**: `node dist/entrypoints/daemon.js` (dev: `tsx watch src/entrypoints/daemon.ts`).
  `MERIDIAN_AUTONOMOUS=true` → resident daemon (cron + Telegram); otherwise a
  one-shot single screening cycle.
- **Two LLM-driven roles + one deterministic cycle** (tool access enforced by `toolFilter`, not the role):
  - `SCREENER` — every `screeningIntervalMin`, picks a pool, calls `deploy_position`. Delegated to Sage in production (`MERIDIAN_DECIDER=sage`); local loop is fallback.
  - **Management (deterministic, no LLM)** — every `managementIntervalMin`, `planForPosition` decides, `executeTool` runs it. Rewired from LLM-in-the-loop → direct calls on 2026-08-02. Since 2026-08-29 an optional **smart-exit regime engine** (`smartExitEnabled`) replaces the static stop with CATASTROPHIC/DYING/HEALTHY/AMBIGUOUS classification; the AMBIGUOUS middle is escalated to Sage for a CLOSE/HOLD verdict (advisory — Sage does not execute). See § Smart-exit regime engine.
  - `GENERAL` — ad-hoc chat (dashboard `/chat`). Telegram inbound is now handled by Sage (Hermes), not this role.
- **State = JSON files** at `STATE_DIR` (default cwd), one repo per file, atomic writes.
  No DB.
- **The real safety gates are `MERIDIAN_CHAIN=meteora` + `MERIDIAN_WRITE_UNSAFE=true`.**
  `DRY_RUN` is *not* consulted for gating in the TS code (it only surfaces as a
  HiveMind capability flag). Getting this wrong = fake trading or, worse, an
  unintended live write.
- **Cross-cutting invariants that are easy to break**: lazy SDK load, `force:true`
  on position reads, once-per-session tool locks (`deploy` = also `noRetry`),
  trailing-TP two-phase 15s confirm, bridge binds `127.0.0.1` only. Details below.

---

## Architecture

```
 entrypoints/daemon.ts  (composition root: boot() wires ports→adapters, main() runs)
        │
        │ AppContext { clock, logger, config, chain, swap, notifier, market{5}, repos{8} }
        ▼
 ┌─────────────────────────── app/ (use-cases) ───────────────────────────┐
 │  screening/cycle   management/cycle + pnl-poller   health   briefing    │
 │  hivemind/sync     telegram/router                                       │
 │            │                    │                                        │
 │            └──────── agent/loop.ts  runAgentLoop() (ReAct) ──────────────┤
 │                          │  buildSystemPrompt(role)  → LLMClient          │
 │                          ▼                                                │
 │              tools/execute.ts  executeTool(registry, call, ctx)          │
 │                 parse(jsonrepair) → args.zod → safety[] → execute → post[]│
 │                          │                                                │
 │              tools/impls/*.ts  (~60 tools, one file each)                 │
 └──────────────────────────┬──────────────────────────────────────────────┘
        uses ports (interfaces)  │  implemented by adapters
        ▼                        ▼
 domain/ (pure: rules, schemas, prompt, config-load)     adapters/
   rules: close-rules, pnl, exit-signals, scoring,          chain/meteora (real), chain/dry-run
          cooldown, deploy-planning, screening              market/* (jupiter, meteora, rugcheck,
   format: decision-strings, enrich-close,                          geckoterminal-kline, + fakes)
           candidate-history, technicals                    persistence/json/* (9 repos, atomic)
   schemas: 15 Zod shapes    ports/: 28 interfaces          swap, llm(+decorators), notify, scheduler,
                                                            logger, hivemind, dashboard (bridge)
```

Everything flows through `AppContext` (ports only — no concrete impls) assembled at
boot in `src/app/tools/context.ts`. Adapters are selected by env in `daemon.ts`.

### Layer map (read before editing)

**`src/entrypoints/daemon.ts`** (611) — composition root. `boot()` (L162-408) loads
config + selects adapters + builds `AppContext`; `main()` (L410-606) wires cron/modes.
- **Adapter selection cascade** (env-driven, defaults chain off each other):
  `MERIDIAN_CHAIN` (`dryrun`|`meteora`, default dryrun, L193) → meteora requires
  `RPC_URL`+`WALLET_PRIVATE_KEY` (throws if missing). `MERIDIAN_PRICE` defaults
  `jupiter` when chain=meteora else `static` (L194). `MERIDIAN_MARKET` defaults
  `real` when chain=meteora else `fake` (L284); selects 5 market ports
  independently. LLM: `MERIDIAN_DEMO=true` or no key → fake LLM; else OpenRouter.
  Notifier: telegram if `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` else collecting.
- **Write arming**: `writesEnabled = MERIDIAN_WRITE_UNSAFE === "true"` (L227), passed
  into the meteora chain client (the real gate lives in the adapter). Recomputed
  in 3 places (L227, L512, L565) — keep consistent.
- **`STATE_DIR`** = `MERIDIAN_STATE_DIR` ?? cwd (L101). Roots all 8 repos. Config
  path uses cwd (`REPO_ROOT`), so config + state can diverge.
- **Modes**: `MERIDIAN_AUTONOMOUS=true` → schedule cycles + Telegram inbound +
  shutdown handlers, stay resident (L456). Else one-shot screening (L586).
- **Dashboard bridge** started (both modes) only if `DASHBOARD_ENABLED=true`, via a
  **dynamic import** (L438) inside try/catch — must never throw fatally.

**`src/domain/`** — pure logic + Zod schemas, no I/O.
- `rules/close-rules.ts:39` `getDeterministicCloseRule` — the **5 hard exit rules**
  (stop-loss, take-profit, pumped-above-range, OOR-wait, low-yield); rules 1&2
  suppressed when PnL is suspect. Same file, since 2026-08-29: `getExitDecision`
  (regime classifier — CATASTROPHIC/DYING/HEALTHY/AMBIGUOUS/OK) + `getPollerFastCut`
  (30s catastrophic + OOR-below fast-cut); `getDeterministicCloseRule` gained a
  `{skipStopLoss}` opt so rules 2/3/4 still fire while the engine owns the downside stop.
  See § Smart-exit regime engine.
- `rules/pnl.ts:17` `assessPnl` — reported vs derived; **divergence is informational
  only, does NOT gate exits** (deliberate — don't re-add gating). `pnl_pct_suspicious`
  fires only when a tick is genuinely unpriceable.
- `rules/exit-signals.ts:35` `evaluateExit` — stateful diff variant (flips
  `trailing_active`, sets `out_of_range_since`, emits STOP_LOSS/TRAILING_TP/OOR/LOW_YIELD).
- `rules/deploy-planning.ts:55` `planDeploy` — pure bin-range validator. Single-side
  SOL only (`amountX` must be 0), total bins ≥ `MIN_SAFE_BINS_BELOW` (35),
  `WIDE_RANGE_THRESHOLD` = 69 flags the multi-tx path.
- `rules/screening.ts:84` `hardFilter` + `rankCandidates`. `defaultThresholds`
  reads straight from `cfg.screening.*`, so `user-config.json` (and live dashboard
  Config edits, applied in-place by `update_config`) drive the hard filter. (Was
  a `void cfg` no-op until 2026-07-13 — that config-drift footgun is fixed.)
- `rules/scoring.ts:14`, `rules/cooldown.ts:7` (`isPoolOnCooldown`/`isBaseMintOnCooldown`).
- `schemas/` (15) — `config.ts`/`config-flat.ts`, `position.ts` (TrackedPosition +
  LivePositionSnapshot + `entry_technicals`), `chain.ts`, `market.ts`, `pool-memory.ts`,
  `strategy.ts`, `decision.ts` (MAX_DECISIONS=100), `lesson.ts` (PerformanceRecord adds
  `base_mint` + `entry_technicals` + `exit_technicals`), `kline.ts` (KlineCandle,
  KlineTimeframe, TechnicalsSummary), `state.ts`, `study.ts`, `smart-wallet.ts`,
  `blacklist.ts`, `dev-blocklist.ts`.
- `format/` — `decision-strings.ts`, `enrich-close.ts`, `candidate-history.ts`
  (per-candidate pool + base_mint history + portfolio aggregate over last N closes),
  `technicals.ts` (pure OHLCV[] → 13-feature TechnicalsSummary: spike_pct,
  at_local_top/bottom, atr_pct via Wilder-14, vol_spike, trend via EMA(20)/EMA(50)
  with 1% dead zone, from_window_high_pct, nearest_support via swing-low detection,
  support_distance_pct, support_touches, consecutive_red_count (trailing red candles,
  added 2026-08-29 for the DYING regime); + `formatTechnicalsLine` + `formatTechnicalsBlock`).
- `prompt/builder.ts:95` `buildSystemPrompt(ctx)` — pure assembler; `roleInstructions`
  = the 3 role prompts. Includes `── LESSONS ──` (pinned + recent 5), `── PERFORMANCE ──`,
  `── DECISIONS ──` when the caller passes them. `prompt/role-tools.ts` —
  `MANAGER_TOOLS`/`SCREENER_TOOLS`/`GENERAL_TOOLS` (SCREENER + GENERAL both include
  `get_pool_kline`).
- `config-load.ts:147` `parseAppConfig(raw): Result<AppConfig,…>` — two-stage Zod:
  flat (`.passthrough()`) → `flatToNested` → nested. Never throws; returns a Result.

**`src/ports/`** (27 interfaces) — the DI contracts. Chain/trading: `ChainClient`
(writes return `{success}` in-band, never throw), `SwapClient`, `SolanaConnection`,
`PriceOracle`. Market: `PoolDiscoveryClient`, `TokenInfoClient`, `RugCheckClient`,
`SmartWalletChecker`, `StudyClient`, `KlineClient` (OHLCV source, fail-open contract —
adapters MUST resolve with `[]` on error, never throw). Persistence (all `load(): Result` + mutators):
`ConfigRepo`, `PositionRepo`, `PoolMemoryRepo`, `DecisionLogRepo`, `LessonRepo`,
`StrategyRepo`, `SmartWalletRepo`, `TokenBlacklistRepo`, `DevBlocklistRepo`. Also
`LLMClient`, `SageDecider` (Path 2 screening delegation — agentic, returns prose not
tool_calls), `SageExitAdvisor` (advisory exit — returns `{CLOSE|HOLD, reason}`, throws
on transport so the caller applies its conditional fallback; added 2026-08-29),
`Notifier`+`LiveMessageHandle`, `TelegramInbound`, `HiveMindClient`,
`Clock`, `Scheduler`, `Logger`.

**`src/adapters/`** — implementations.
- `chain/meteora/connection.ts` — `loadWalletKeypair` accepts JSON byte-array OR
  base58 (never base64); `createSolanaConnection` lazy-imports `@solana/web3.js`.
- `chain/meteora/client.ts:137` — read paths + write dispatch. **Positions cache 5min
  TTL + inflight dedup**; `force` bypasses. `getWalletBalance/getMyPositions/getActiveBin`.
  Lazy `@meteora-ag/dlmm` import (`loadDlmmSdk`, CJS explodes on eager ESM import →
  `postinstall scripts/patch-anchor.js` is required). `MeteoraWritePathNotPortedError`
  thrown by `assertWritable` when not armed.
- `chain/meteora/write-paths.ts` — `deploy`/`close`/`claim`, gated. Standard (≤69 bins)
  = one tx; **wide-range (>69) = two-phase multi-tx** (`createExtendedEmptyPosition` +
  `addLiquidityByStrategyChunkable`) due to Solana's 10240-byte realloc cap.
- `chain/dry-run.ts` — deterministic fake chain (no network); preserves cache/force/dedup.
- `market/` — real: `jupiter-price-oracle` (**Jupiter Price v3** `lite-api.jup.ag/price/v3`,
  30s TTL, retry×2), `jupiter-token-info`, `meteora-pool-discovery`, `rugcheck`,
  `meteora-smart-wallet-checker`, `agent-meridian-study`, `geckoterminal-kline`
  (keyless OHLCV, `api.geckoterminal.com/api/v2`, per-key 60s TTL + inflight dedup,
  4s timeout, fails open on 429/5xx/malformed); test doubles: `fake-*`,
  `static-price-oracle`, `fake-kline`.
- `persistence/json/` — 9 repos over `atomic-write.ts` (temp+fsync+rename, crash-safe):
  `position-repo` (state.json; caps `recentEvents` to 20), `pool-memory-repo`,
  `lesson-repo`, `decision-log` (caps to 100), `strategy-repo`, `smart-wallet-repo`,
  `token-blacklist-repo`, `dev-blocklist-repo`, `config-repo`. **No `signal-weights`
  repo** (not ported).
- `swap/jupiter-swap.ts` — **Jupiter Swap/Quote v6**. `llm/openrouter.ts` (real),
  `llm/fake.ts`, plus decorators `with-provider-fallback`, `with-system-role-fallback`,
  `with-tool-choice-retry` (available but **not wired by default** in daemon.ts — the
  loop is intentionally thin, so resilience is opt-in via these decorators).
- `llm/sage-decider-http.ts` — `SageDecider` impl (Path 2). OpenAI-compatible POST to
  Hermes' api server; sends `X-Hermes-Session-Key` + CF Access headers + an explicit
  `User-Agent` (CF blocks default UAs → 403/1010); throws `SageTransportError` on
  timeout/transport so the screening cycle falls back to the local loop.
- `llm/sage-exit-advisor-http.ts` — `SageExitAdvisor` impl (2026-08-29). Same Hermes
  transport pattern (reuses `SageTransportError`, `FetchLike`); sends one position's
  signal block + an exit-specific system prompt, parses a `CLOSE:`/`HOLD:` line
  (`parseExitVerdict`). Unparseable/timeout → throws so management applies the
  conditional fallback. `llm/fake-sage-exit-advisor.ts` is the test double.
- `notify/` (telegram, telegram-inbound, collecting, null), `scheduler/`
  (interval, manual), `logger/console.ts`, `hivemind/agent-meridian.ts`.
- `dashboard/` — the control bridge (see § Dashboard bridge).

**`src/app/`** — use-cases (see the dedicated sections below).

---

## The ReAct loop (`src/app/agent/loop.ts:62`)

`runAgentLoop(deps={llm,registry,ctx}, opts)` — the single entry (no `agentLoop` alias).
- `opts`: `role`, `goal`, `systemPrompt`, `model`, `maxSteps` (default 20), `history`,
  `toolFilter`, `requireToolOnFirstStep`, `onToolStart/onToolFinish`.
- Each step: `llm.chat({...})`. `tool_choice="required"` only when
  `requireToolOnFirstStep && step===0`, else `"auto"`.
- **No-tool retry**: if a tool was required on step 0 and the model returned text, it
  injects a reminder and continues once; a second text-only reply ends with
  `no_tool_after_reminder`.
- **Once-per-session tool locks** (`agent/session-locks.ts`): `oncePerSession` locks
  after **success**; `noRetry` locks after the **first attempt regardless of outcome**.
  `deploy_position` = both (double-spend guard); `close_position`/`swap_token` =
  `oncePerSession`. A blocked call returns a `safety_blocked` error, never throws.
- **JSON repair** lives in the executor (`tools/execute.ts` `parseArgs` → `jsonrepair`),
  not the loop. **Provider fallback is NOT in the loop** (v1 assumes a well-behaved
  provider); use the `llm/with-*` decorators if you need it.
- **`role` is a label** — tool access is enforced purely by `toolFilter` →
  `registry.subset(names)`. Pass a role without the matching filter and the whole
  registry leaks.

---

## Agent roles & tool access

| Role | Tool list (`src/domain/prompt/role-tools.ts`) | Caller |
|---|---|---|
| `SCREENER` | `SCREENER_TOOLS` (13) — deploy + discovery/enrichment + `get_pool_kline` | `screening/cycle.ts:167`, `requireToolOnFirstStep:true` |
| `MANAGER` | `MANAGER_TOOLS` (5) — close/claim/swap + reads | `health/cycle.ts:65` (management cycle no longer uses this — it calls `executeTool` directly since 2026-08-02) |
| `GENERAL` | `GENERAL_TOOLS` (11) — includes `get_pool_kline` for ad-hoc TA in chat | `telegram/router.ts:365`, `requireToolOnFirstStep:false` |

There is **no INTENT-pattern matcher** in the TS version — GENERAL is simply the
`GENERAL_TOOLS` list. The dashboard `/chat` surface uses a separate read-only
`CHAT_READ_TOOLS` list (`src/adapters/dashboard/allowlist.ts`) so it literally cannot
pick a write tool.

### Adding a new tool

1. **`src/app/tools/impls/<name>.ts`** — `defineTool({ name, description, args (Zod),
   result (Zod), execute, safety?, post?, oncePerSession?, noRetry? })`. The Zod
   schemas are the single source for both the OpenAI JSON-Schema contract and runtime
   validation (no drift).
2. **Register it** — add to the registry assembly (`createRegistry([...])`) so
   `ToolRegistry` knows it.
3. **Role access** — add the name to `MANAGER_TOOLS` / `SCREENER_TOOLS` /
   `GENERAL_TOOLS` in `src/domain/prompt/role-tools.ts` as appropriate.
4. **If it writes on-chain** — give it a `safety[]` gate chain + `oncePerSession`
   (+ `noRetry` for deploy-like double-spend risk), and add it to the dashboard
   `WRITE_TOOLS_DASHBOARD` allowlist (it stays behind the `/tool` confirm gate).

### Tool execution pipeline (`src/app/tools/execute.ts:32`)

`parseArgs` (JSON.parse → jsonrepair fallback) → `args.safeParse` → **safety chain**
(each `SafetyCheck` returns `null`=pass / `{reason}`=deny, runs BEFORE execute) →
`execute` (thrown errors → `execute_failed`) → `result.safeParse` → **post hooks**.
Every failure is a discriminated `ToolError`, never a throw.
- **Safety gates** (`tools/safety/*`): `poolCooldownGate`, `walletBalanceGate`,
  `maxPositionsGate` (uses `force:true`), `tokenBlacklistGate`, `deployerBlocklistGate`
  (**fails OPEN** on enrichment error; the other four fail closed).
- **Post hooks** (`tools/post/*`): `notify.*` (Telegram cards, guarded on
  `result.success`), `log-decision.*` (append to decision log — plain-English
  summary + reason since 2026-08-02, see `domain/format/decision-strings.ts`),
  `consolidate.ts` (auto-swap base → SOL after close), `track-position.ts` (upsert
  tracked position on deploy), and `mark-closed.ts` (flip repo `closed:true` on
  close — added 2026-08-02 to stop state.json ghost-open accumulation).
  **Post-hook failures are swallowed + logged, never fail the tool.**

---

## Cron & cycle architecture

Scheduled in `main()` (autonomous mode) via `createIntervalScheduler`:

| Task | Cadence | Function |
|---|---|---|
| screening | `screeningIntervalMin` | `runScreeningCycle` (`src/app/screening/cycle.ts:53`) |
| management | `managementIntervalMin` | `runManagementCycle` (`src/app/management/cycle.ts:88`) |
| pnl-poller | 30s (+15s confirm) | `createPnlPoller` (`src/app/management/pnl-poller.ts:141`) |
| health | `healthCheckIntervalMin` | `runHealthCycle` (`src/app/health/cycle.ts:24`) |
| briefing | 24h (hardcoded) | `runBriefingCycle` (`src/app/briefing/cycle.ts:16`) |
| hivemind-sync | 15m (hardcoded) | `createHiveMindSync` (`src/app/hivemind/sync.ts:38`) |
| follow | 15s base tick, gated to `follow.intervalSec` | `createFollowWatcher` (`src/app/follow/cycle.ts`) — always constructed; enable/interval read per tick |

The scheduler skips overlapping ticks per label (the `_busy` guard is built in).

### Screening cycle
1. **Preflight**: wallet/positions(`force:true`)/strategy/decisions/`recentPerformance(50)`/`listLessons({limit:20})`.
   Skip (write a `skip` decision) if at `maxPositions` or
   `wallet.sol < deployAmountSol + gasReserve`.
2. **Candidates**: `get_top_candidates` tool → discovery → `hardFilter` → `rankCandidates`.
3. **0 candidates** → `no_deploy` decision, no LLM.
4. **Diligence pre-enrichment** (added 2026-08-02): `enrichCandidates` fetches
   `rugCheck.check(mint)` + `tokenInfo.getHolders(mint, 10)` in parallel per candidate
   with a 3s per-call timeout, fails open. Result is injected as a `diligence:` line
   per candidate in `formatCandidatesBlock`. This lets Sage's autonomous cycle veto
   / override on FRESH data without racing the 90s timeout on gmgn-cli side calls.
5. **Technicals pre-enrichment** (added 2026-08-10, Phase 3b): `enrichTechnicals`
   runs alongside diligence — per candidate × timeframe (`["15m","1h"]` by default,
   changed from `["5m","1h"]` 2026-08-20: 5m too noisy on DLMM + swapping in 15m
   makes `rejectOnMissingTrend` naturally catch <12.5h tokens since neither 15m nor
   1h will have EMA50 populated),
   parallel `market.kline.getKline`, 3.5s per-call timeout, fails open. Each result
   is passed through pure `computeTechnicals` and rendered as a `technicals:` block
   under the candidate line. Sage sees spike / support / trend / ATR / vol_spike
   inline — no `mrd_get_pool_kline` call needed inside the delegation.
   **TA hard gate** (fail-closed, applied to the technicals-enriched shortlist) rejects
   on 5 modes: `missing_trend` (all TFs null + `rejectOnMissingTrend`), **`drawdown`
   (2026-08-29 — worst `from_window_high_pct` < `-maxFromHighPct` (default 35) on ANY
   TF, TREND-INDEPENDENT)**, `capitulation` (all-DOWN + deep + no-support + dead-vol),
   `atr_extreme` (> `maxAtrPct`), `spike_top` (> `maxSpikePct` AND `at_local_top`). The
   drawdown mode was added after Zoe/GTA6/Morty stop-losses: bought −33 to −50% below
   high on a 1h `trend=UP` dead-cat bounce that the trend-gated capitulation check missed.
6. **History injection**: `computeCandidateHistory` (per-candidate pool + base_mint
   matches from `recentPerformance`) renders as a `history:` line; the aggregate
   `computePortfolioAggregate` (buckets by strategy / volatility / entry_mcap over
   last 30 closes) appends `PRIOR EXPERIENCE:` to the `goal` block. `── LESSONS ──`
   (pinned + recent 5) is injected into both the local-loop `buildSystemPrompt` AND
   the Sage `sageSystemPrompt`.
7. **Decision** — two deciders, selected by `MERIDIAN_DECIDER`:
   - default (`loop`): SCREENER prompt + candidate block, `runAgentLoop` `maxSteps:8`,
     `requireToolOnFirstStep:true` — the local LLM must call `deploy_position` (or justify).
   - **`sage`** (Path 2): delegate to the external Sage agent via the `SageDecider` port
     (`src/ports/sage-decider.ts` + `adapters/llm/sage-decider-http.ts`). Sage reasons
     with its own memory AND deploys itself through the dashboard bridge, so it returns
     only prose — "did a deploy happen?" is answered by **position-id set diff**
     (robust to a concurrent close), not the text. A `cycle_id` is passed for
     idempotency. On transport error/timeout → **fall back to the local loop** (same
     `cycle_id`); skipped if a deploy already landed (no double-deploy). A clean Sage
     "no-deploy" is NOT a failure — never falls back on it. Full ops:
     [`deploy/SAGE-MERIDIAN-ROLLOUT.md`](deploy/SAGE-MERIDIAN-ROLLOUT.md).

### Management cycle (fully deterministic — no LLM)
1. `getMyPositions({force:true})`.
2. **Forward reconcile**: any on-chain position missing from state.json → upsert
   into tracking store (deploy_position hook missed it, or was deployed pre-fix).
3. **Reverse reconcile** (added 2026-08-02): any tracked position marked open but
   NOT in the on-chain snap → flip `closed:true, closed_at:now` and note
   "reconciled: no longer on-chain". Catches historical ghost records + external
   closes (Meteora UI, ad-hoc script — and, before 2026-09-26, the pnl-poller's
   direct chain call; see § PnL poller). Without this,
   `buildStateSummary` reports stale open counts (e.g. dashboard summary showed
   36 records vs 0 on-chain before the fix).
4. **OHLCV enrichment** (`enrichPositionTechnicals`, 2026-08-29, fail-open like
   screening's) — fetch 15m+1h per open position so the regime engine has structure.
5. `planForPosition` per position: `smartExitEnabled=false` → legacy path (static
   `getDeterministicCloseRule`, rule 1 = static stop). `smartExitEnabled=true` →
   rules 2/3/4 via `{skipStopLoss}` + **`getExitDecision`** owns the downside stop.
   The classified regime is logged EVERY tick (shadow) even when disabled, for a
   pre-arming review window. Then CLAIM if `unclaimed_fees_usd >= minClaimAmount` → STAY.
6. **AMBIGUOUS escalation** (smart mode) — a position the engine can't resolve is sent
   to `resolveEscalation`: per-position cooldown (`sageExitCooldownMin`) → if
   `sageExitEnabled` + advisor present, `SageExitAdvisor.decide` → CLOSE/STAY; on
   transport error/timeout OR `sageExitEnabled=false`, conditional fallback (in-range →
   HOLD, OOR → CLOSE). Sage advises; management executes.
7. If **all STAY → `{kind:"all_stay"}`**.
8. Else iterate non-STAY actions sequentially, invoke `close_position` /
   `claim_fees` **directly via `executeTool`** (safety gates + post-hooks + notify
   card + decision log + auto-swap still fire). Returns `{kind:"executed", results}`.
   No LLM: zero token cost, no latency, no once-per-session cap on closes-per-tick
   (the LLM loop's `oncePerSession` lock on `close_position` was silently capping
   this to 1 close per cycle). Removed 2026-08-02.

### PnL poller (trailing-TP two-phase confirm)
- Tick 1: a trailing drop (`peak - current >= trailingDropPct`, with
  `peak >= trailingTriggerPct`) is **queued**, not fired.
- ~15s later: re-check; fire `close_confirmed` only if the drop still holds within
  1% tolerance. **`peak_pnl_pct` is merged from the position repo** before the pure
  tick — forget it and trailing-TP silently never triggers.
- **Smart-exit fast-cut** (2026-08-29, gated on `smartExitEnabled`): each tick also
  runs `getPollerFastCut` (on-chain only, no OHLCV) — CATASTROPHIC floor
  (`pnl ≤ exitHardFloorPct`) + OOR-below proxy (`active_bin < lower_bin` AND
  `pnl ≤ exitOorProxyPct`). Fires an immediate `fast_cut` action (no two-phase confirm);
  the position is skipped by the trailing scan that tick. Dark-launch default off = poller
  behaves exactly as before.
- **Pnl warm-up** (`PNL_WARMUP_MINUTES` = 5, `close-rules.ts`, 2026-09-26): neither the
  fast-cut nor `getExitDecision` acts on pnl for a position younger than 5 min. Meteora
  datapi reads a fresh deposit as pnl −100% for a few seconds; the poller fast-cut
  OTC-SOL and FLAME-SOL 3–5 s after deploy on that reading. The poller derives age
  from `tracked.deployed_at` (the chain client leaves `age_minutes` null) and treats an
  UNTRACKED position as age 0 — the deploy post-hook just hasn't written it yet.
  Unknown age (`null`) is never warm-up, which is why management passes
  `age_minutes ?? null`, not `?? 0`.
- **Every close goes through the `close_position` tool** (`closeViaTool`,
  `src/app/tools/close-via-tool.ts`), injected into the poller as `deps.closePosition`.
  Telegram `/close` + `/closeall` use it too. **Never call `chain.closePosition` from
  a cycle**: the tool's post-hooks are the ONLY writers of the performance record
  (dashboard History), decision log, cooldown and `closed:true`. Until 2026-09-26 the
  poller closed directly, so every smart-exit loss cut was missing from History and
  only surfaced as a "reconciled: no longer on-chain" ghost.

---

## Position lifecycle & the 5 deterministic close rules

`getDeterministicCloseRule` (`src/domain/rules/close-rules.ts:39`):
1. **Stop loss** — `pnl_pct <= stopLossPct`
2. **Take profit** — `pnl_pct >= takeProfitPct`
3. **Pumped above range** — `active_bin > upper_bin + outOfRangeBinsToClose`
4. **OOR wait** — `active_bin > upper_bin && minutes_out_of_range >= outOfRangeWaitMinutes`
5. **Low yield** — `fee_per_tvl_24h < minFeePerTvl24h && age_minutes >= 60`

Rules 1 & 2 are suppressed when PnL is suspect (`isPnlSuspect`); range rules (3-4)
fire regardless. On close, `post/log-decision` records it and `post/notify` sends the
Telegram card. Cooldowns live in `pool-memory` + `rules/cooldown.ts`.

### Smart-exit regime engine (`smartExitEnabled`, 2026-08-29)

Design doc: [`deploy/SPEC-2026-08-29-smart-exit-regime-engine.md`](deploy/SPEC-2026-08-29-smart-exit-regime-engine.md).
When `smartExitEnabled=true`, `getExitDecision` (`close-rules.ts`) replaces the **static
rule-1 stop** with a regime classifier (rules 2/3/4 + trailing-TP unchanged, called with
`{skipStopLoss:true}`). Priority order per position:

1. **CATASTROPHIC** — `pnl ≤ exitHardFloorPct` (−25) → CLOSE, unconditional backstop.
2. **DYING** (cut early, at ANY pnl) — OOR-below AND (support broken OR both-TF DOWN OR
   `atr_pct < dyingAtrCollapsePct`), OR `consecutive_red_count ≥ dyingConsecutiveRed` AND
   fee velocity < `minFeePerTvl24h` → CLOSE.
3. attention gate — `pnl > stopLossPct` and not DYING → HOLD (regime OK). `stopLossPct`
   is reused as the "worth-a-decision" threshold; DYING is checked BEFORE it so a
   collapsing position is cut before it reaches the stop.
4. **HEALTHY** — in-range AND `fee_per_tvl_24h ≥ healthyFeeVelocityMin` AND not both-TF
   DOWN → HOLD past the stop (let fees work; the user's "don't stop out a working position").
5. **AMBIGUOUS** — everything else → ESCALATE (management asks Sage; see cycle step 6).

Suspect/null pnl → HOLD (defer to range rules). Two cadences: the 30s poller runs the
cheap `getPollerFastCut` subset (CATASTROPHIC + OOR proxy, no OHLCV); the 10-min
management cycle runs the full classifier with fresh OHLCV. **Dark-launch: default off**
— when off, exit behavior is byte-identical to the legacy static stop, but the regime is
still classified + logged (shadow) for a review window. Arm via dashboard Config (Exit
rules tab): `smartExitEnabled` first, `sageExitEnabled` second. Config field `stopLossPct`
becomes the *attention* threshold (not a hard close) in smart mode.

---

## Follow-the-wallet (`follow.enabled`, 2026-09-20)

Copy-trading. Meridian mirrors a chosen wallet's DLMM entries and exits, **deliberately
bypassing screening, the TA gate, pool/token cooldowns and both blacklists** — the user's
judgement about the wallet replaces the bot's judgement about the pool. Two switches must
both be on: `follow.enabled` (global) and `enabled` on the individual wallet.

**Reading the other wallet** — NOT via `getMyPositions` (see § Known issues: its
`wallet_address` option is ignored). The `WalletWatcher` port
(`adapters/market/meteora-wallet-watcher.ts`) hits Meteora's public datapi, no RPC and no
SDK: `GET /portfolio/open?user=<w>` for the pool set, `GET /positions/<pool>/pnl?user=<w>`
for bin range + deposit + PnL.

**The cycle** (`src/app/follow/cycle.ts`):
1. **Reverse reconcile** (mirrors management's ghost-open sweep): any open mirror whose
   position is gone on-chain is finalised. Without it, `close_position` would later throw
   "pool for position … not found in snapshot" AND the stale record would keep matching
   the `already_mirrored` guard, blocking that pool from ever being mirrored again.
   Records younger than `RECONCILE_GRACE_MS` (3 min) are skipped — a deploy returns its
   position address before the RPC is guaranteed to serve it, and reconciling inside that
   window would orphan a position that is genuinely open (which, under `exclusiveExit`,
   nothing else would ever close).
2. Per enabled wallet: snapshot their open pools → `diffFollowedWallet`
   (`domain/rules/follow-diff.ts`, pure).
3. **Re-center detection** (`detectRecenter`, gated on `mirrorRecenter` + a reliable
   snapshot): for each mirror whose pool the wallet is STILL in, compare their current
   position against what we copied. Their recorded position address gone, or their lower
   bin drifted past `recenterBinThreshold`, means they closed and reopened in place —
   invisible to a pool-membership diff. We close, and withhold that pool from the
   baseline so the next tick re-mirrors at the new range (re-opening in the same tick
   would race the just-closed position still showing on-chain). This matters because
   `exclusiveExit` disabled the OOR rule that used to clean up a stranded range.
4. **Closes run before opens** so an intra-tick rotation frees its `maxPositions` slot first.
5. opens are bounded by `mirrorCapacity` — `min(maxPositions - ourOpen, maxMirrored -
   openMirrors)`. Mirrors have no local exit, so without their own cap they hold every
   portfolio slot indefinitely; `maxMirrored` (default 2 against `maxPositions` 3)
   reserves the remainder for the screener, and the screening cycle's max-positions skip
   now names how many slots follow is holding.
6. mirror-open → `follow_deploy_position` via `executeTool`; mirror-close → `close_position`.
7. advance the per-wallet `seen` baseline.

**`follow.exclusiveExit` (default TRUE) — the followed wallet owns the exit.** Mirrored
positions are exempt from EVERY local close rule: the management cycle forces their
CLOSE/ESCALATE plans to STAY (`management/cycle.ts`), and the pnl-poller filters them out
of the snapshot before trailing-TP and the smart-exit fast-cut run (`pnl-poller.ts`, gated
on the optional `followRepo` dep, so behaviour is unchanged when it is absent). CLAIM is
deliberately untouched — collecting fees does not end a position. **This means a mirrored
position has no local downside protection**: if the source wallet goes quiet or datapi
stays unreachable, nothing closes it. That is why the stale-snapshot alert exists. Set the
flag false to hand mirrors back to the normal exit rules.

**Ownership: the exemption only covers mirrors a wallet is still there to own**
(`partitionMirrorOwnership` in `domain/rules/follow-diff.ts`, added 2026-09-20). Handing a
position's exit to a wallet is only sound while that wallet is being polled. Three things
end that — `follow.enabled` goes off, the wallet is disabled, the wallet is removed — and
each one used to leave a position answering to NOBODY: the follow cycle skips it, and the
local rules had already been handed away. Both consequences are now wired:

- **The cycle drains orphans by closing them** (`drainOrphans`). Unfollow means unwind.
  It reads `follow-state.json` through `repo.load()`, never `listWallets()`, because that
  helper answers an unreadable file with an empty array — which is exactly what a
  deliberate unfollow looks like, so a parse error would liquidate every mirror. A failed
  read refuses the whole tick. Same rule as the datapi `reliable` flag: **a read that
  failed is missing information, never an instruction to exit.**
  The drain runs AFTER the reverse reconcile (so a position already gone on-chain is
  finalised, not closed twice) and BEFORE the `follow.enabled` early return (so turning the
  switch off drains what the switch just orphaned). A failed drain leaves the record open
  and retries next tick, matching the close-is-retried asymmetry below. Telegram is warned
  BEFORE the writes, naming the cause.
- **Management and the poller re-arm local rules over orphans** in the meantime — both
  filter `listOpenMirrored()` through `partitionMirrorOwnership` and exempt only `owned`.
  This is what covers the ≤`intervalSec` window before the drain, and the case where the
  follow watcher is not running at all.

> **`followEnabled: false` executes trades.** It is not a pause button: flipping it off
> closes every open mirror. Note the flat-schema default is `false`, so restoring a config
> that predates this feature also triggers a drain. `scheduledTick` deliberately does not
> short-circuit on disabled for this reason — but a disabled tick with nothing to drain
> does not consume the interval budget, so re-enabling still polls on the next base tick.

**Three asymmetries carry the safety of this feature** — change them and you get either
mass-mirroring or mass-closing:
- **First sight seeds, never mirrors.** Cold start, re-enable and re-add all clear the
  baseline, so none of them back-fill positions the wallet already holds.
- **An unreliable snapshot suppresses CLOSES but still allows OPENS.** A truncated page
  list can hide a still-open pool; reading that as an exit would close everything on a
  transient datapi 502. It cannot invent a pool, so a newly seen pool is always genuine.
  A degraded snapshot also never becomes the baseline. **`reliable` covers truncation, not
  just errors** (fixed 2026-09-20): the snapshot is trusted only when a page positively
  reports the end of the list — `hasNext:false`, or (when that field is absent/null) a
  page shorter than `PAGE_SIZE`. Exhausting `MAX_PAGES`, or a FULL page with no
  continuation signal at all (the field renamed upstream), yields `reliable:false`.
  `hasNext:false` is still trusted on a full page, so a wallet holding exactly 50 pools
  does not become permanently unreliable — which would strand its mirrors the other way.
- **A failed mirror-OPEN is NOT retried** (the baseline advances regardless, matching
  `deploy_position`'s `noRetry` rationale), but a failed mirror-CLOSE **is** — the record
  stays open and the source wallet is still absent from the pool, so the next tick tries
  again. Retrying a deploy risks a double-spend; retrying a close does not. The orphan
  drain inherits this: a failed drain stays open and is re-attempted.
- **Sustained degradation escalates.** Consecutive unreliable polls per wallet are counted
  in-process; at `follow.staleTicksBeforeAlert` a Telegram warning names how many mirrors
  are currently unprotected. Suppressing closes is safe against a FALSE exit but not a
  MISSED one, and under `exclusiveExit` those positions have no local stop either.

**Gates** — `follow_deploy_position` is a separate tool from `deploy_position` precisely
so the gate list can differ: dropped = pool cooldown, base-mint cooldown, token blacklist,
deployer blocklist; **kept** = wallet balance, max positions. It is registered in
`ALL_TOOLS` but absent from every role list in `domain/prompt/role-tools.ts` and from
`WRITE_TOOLS_DASHBOARD` — no LLM and no bridge caller can reach it, only the follow cycle.

**A source position that cannot be READ is never guessed at** (fixed 2026-09-20).
`WalletWatcher.getPositionsInPool` resolves `null` on a failed read and `[]` when the
wallet genuinely holds nothing there; the two used to be the same empty array. Callers now
split three ways, and `mirrorOpen` returns `opened | abandoned | retry` to say which:
- **read failed → `retry`.** No deploy, and the pool is WITHHELD from the `seen` baseline
  (same mechanism as a re-center) so the next tick reads it again. Safe to retry precisely
  because nothing was written — the `noRetry` rule covers attempted writes, not reads that
  never got that far. `getActiveBin` and `getWalletBalance` failures take this path too.
- **read succeeded, empty → `abandoned`.** They left between the two polls. Baseline
  advances. Logged at WARN, not info: the portfolio and positions endpoints are
  contradicting each other, which is fine once and a bug if it repeats — without the warn,
  a `/pnl` shape change would mean follow silently never mirrors again.
- **deploy failed → `abandoned`.** Never retried (the original double-spend rationale).

Before this, a datapi blip at open produced a mirror in the right pool at the wrong width
(`fallbackBinsBelow`) with `source_position` and `source_lower_bin` both null — and since
`detectRecenter` keys on exactly those two, that mirror could never detect a re-center for
the rest of its life. Nothing logged it.

**Sizing + range.** `planMirrorSize` takes `positionSizePct` of SOL free after
`gasReserve`, clamped to `[minDeploySol, maxDeploySol]` — their size is irrelevant.
`planMirrorRange` can only mirror the **depth below the active bin**
(`activeBin - theirLowerBin`): `planDeploy` supports single-side SOL only, which pins the
upper bound to the active bin. Copied widths may fall under the 35-bin screener floor, so
`DeployArgs.allow_tiny_range` waives `MIN_SAFE_BINS_BELOW` on this path ONLY.

**Learning** (`src/app/follow/learn.ts`). Entry technicals are captured at mirror-open and
exit technicals at mirror-close, both persisted on the mirror record. With
`followLearnEnabled`, the close then asks the LLM to infer why the wallet entered and
exited and writes a `[follow:<label>] …` lesson tagged `follow` + `wallet:<prefix>`, which
flows into future prompts through the normal `── LESSONS ──` block.

**Every follow flag is hot-reloadable.** The watcher is constructed unconditionally in
autonomous mode and re-reads `follow.enabled` and `intervalSec` on each 15s base tick;
`llm`/`model` are always passed so `learnEnabled` can be turned on live; the pnl-poller
receives `ctx.config.follow` by reference and reads `exclusiveExit` per tick; the
management cycle reads it per cycle. This matters because `update_config` mutates each
config section **in place** for exactly this reason — gating any of these at boot makes
the dashboard Config page silently lie (save succeeds, behaviour does not change until
the next restart). If you add a follow flag, read it at use time, never at wiring time.

**Management tools**: `add_follow_wallet`, `remove_follow_wallet`, `list_follow_wallets`,
`set_follow_wallet_enabled` (in `GENERAL_TOOLS` + the dashboard allowlist). Removing or
disabling a wallet CLOSES its mirrored positions on the next follow tick; both tools report
the pending count as `mirrors_to_close`. The closes are deliberately left to the cycle
rather than run inside the tool — one path owns close mechanics, notifications and
retry-on-failure, and a hand-edited config then drains identically.

---

## Persistent files (JSON at `STATE_DIR`, atomic writes)

| File | Repo | Owns |
|---|---|---|
| `state.json` | position-repo | tracked positions (+`entry_technicals` since 2026-08-10, +`last_sage_exit_escalation_at` since 2026-08-29) + recent-events ring (capped 20) |
| `pool-memory.json` | pool-memory-repo | per-pool deploy history, win rates, cooldowns |
| `lessons.json` | lesson-repo | lessons + performance records (PerformanceRecord now carries `base_mint`, `entry_technicals`, `exit_technicals`) |
| `decision-log.json` | decision-log | rolling 100 decisions (deploy/close/skip/no_deploy/note) |
| `strategy-library.json` | strategy-repo | saved strategies + active pointer |
| `smart-wallets.json` | smart-wallet-repo | tracked KOL/alpha wallets (type lp\|holder) |
| `token-blacklist.json` | token-blacklist-repo | mint → reason |
| `dev-blocklist.json` | dev-blocklist-repo | deployer wallet → reason |
| `follow-state.json` | follow-repo | followed wallets + per-wallet last-seen pool set + mirror records (capped 200, closed pruned first) |
| `user-config.json` | config-repo | the live config (loaded → nested `AppConfig`) |

All writes are temp-file + fsync + atomic rename **except `user-config.json`**, which is
written with `writeJsonAtomic(..., {inPlace:true})` — under Docker it was a single-file
bind mount whose rename detaches the inode (see § Known issues); the in-place write is
kept because it is strictly safer. Config redaction (`*key/token/secret*`) happens when a
file is served over the bridge. On the current homeserver both the state files and
`user-config.json` are plain files on the repo root — see
`deploy/homeserver/README.md`.

---

## Config system

`user-config.json` (flat on disk) → `parseAppConfig` (`src/domain/config-load.ts`):
- `FlatUserConfigSchema` (`schemas/config-flat.ts`, `.passthrough()` so unknown keys
  survive) → `flatToNested` → `AppConfigSchema` (`schemas/config.ts`, 13 subsections:
  `risk, management, strategy, schedule, screening, llm, darwin, hiveMind, api, jupiter,
  indicators, tokens, pnl`). Returns a `Result` — never throws.
- **`strategy` enum = `spot | curve | bid_ask` only (no `auto`).** A config with
  `strategy:"auto"` fails validation → if a caller throws on that Result, the daemon
  crash-loops. Model fields must be exact provider slugs (e.g. `minimax/minimax-m2.7`).
- `bins*` fields hard-floor at `MIN_SAFE_BINS_BELOW` (35). `pnl.source` = `rpc|meteora`
  (default rpc, `pnlRpcUrl` default `https://pump.helius-rpc.com`).
- `update_config` writes back via `nestedToFlat` merged with the original flat
  (its doc comment is stale — trust the code), using `writeJsonAtomic {inPlace:true}`
  (bind-mount safe — see § Known issues).
- **Smart-exit keys** (`management`, added 2026-08-29): `smartExitEnabled` (false),
  `exitHardFloorPct` (−25), `exitOorProxyPct` (−12), `dyingConsecutiveRed` (4),
  `dyingAtrCollapsePct` (10), `healthyFeeVelocityMin` (12), `sageExitEnabled` (false),
  `sageExitCooldownMin` (20). **Entry key** (`screening`): `maxFromHighPct` (35).
  All have flat-schema defaults, so a live config missing them gets the defaults at boot
  (no manual edit).
- **Follow-the-wallet keys** (`follow`, added 2026-09-20): `followEnabled` (false),
  `followIntervalSec` (45), `followPositionSizePct` (0.35), `followMinDeploySol` (0.05),
  `followMaxDeploySol` (1), `followMinBinsBelow` (20), `followMaxBinsBelow` (120),
  `followFallbackBinsBelow` (55), `followStrategy` (spot), `followLearnEnabled` (true),
  `followExclusiveExit` (true), `followStaleTicksBeforeAlert` (5), `followMaxMirrored` (2),
  `followMirrorRecenter` (true), `followRecenterBinThreshold` (10).
  Surfaced on the dashboard Config page under a **Follow wallet** tab. Any NEW field on a persisted schema MUST be `.optional()`/`.default()`
  or old `state.json`/`lessons.json` fail to load — see § Known issues.

---

## Environment variables

| Var | Role |
|---|---|
| `WALLET_PRIVATE_KEY` | base58 or JSON byte-array (NOT base64). Required for meteora. |
| `RPC_URL` | Solana RPC. Required for meteora. Wallet balance = `getBalance` on this. |
| `OPENROUTER_API_KEY` (or `LLM_API_KEY`) | LLM. `LLM_BASE_URL` overrides endpoint. |
| **`MERIDIAN_CHAIN`** | `meteora` selects the real chain (+ cascades market=real, price=jupiter). Default `dryrun`. |
| **`MERIDIAN_WRITE_UNSAFE`** | `true` arms real writes. Without it, write paths throw. |
| `MERIDIAN_MARKET` / `MERIDIAN_PRICE` | override the cascade (`real`/`fake`, `jupiter`/`static`). |
| `MERIDIAN_AUTONOMOUS` | `true` = resident daemon; else one-shot. |
| `MERIDIAN_STATE_DIR` | where JSON state lives (default cwd). |
| `MERIDIAN_DEMO` | `true` forces the fake LLM. |
| `DASHBOARD_ENABLED` / `DASHBOARD_PORT` / `DASHBOARD_TOKEN` | bridge on/off, port (8787), Bearer token. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_ALLOWED_USER_IDS` | ops surface + auth. In production (since 2026-08-02) `TELEGRAM_BOT_TOKEN` is Sage's bot token — Meridian and Hermes share the same bot identity (@SageHermesAnd_bot); Meridian only writes, Hermes handles inbound. |
| `MERIDIAN_TELEGRAM_INBOUND` | **must be `false` in production** — two processes polling the shared token = `getUpdates` 409. Set as compose default. |
| **`MERIDIAN_DECIDER`** | `sage` → screening delegates the deploy decision to Sage (Path 2); anything else / unset = local LLM loop. **Compose default is `sage` since 2026-08-02.** |
| `SAGE_BASE_URL` / `SAGE_API_KEY` / `SAGE_SESSION_KEY` / `SAGE_TIMEOUT_MS` | Sage endpoint (Hermes api), memory-scope header, delegation timeout (default 90s). Only read when `MERIDIAN_DECIDER=sage`. **Unset on the current homeserver → Sage is disabled and screening uses the local ReAct loop.** (Vivobook-era value was the intra-host `http://host.docker.internal:8643`.) |
| `SAGE_EXIT_TIMEOUT_MS` | `SageExitAdvisor` request timeout (default 30000). The exit advisor reuses `SAGE_BASE_URL`/`SAGE_API_KEY`/`SAGE_SESSION_KEY`; the advisor is created whenever those are set, but only consulted when `sageExitEnabled=true`. |
| `SAGE_CF_ACCESS_CLIENT_ID` / `SAGE_CF_ACCESS_CLIENT_SECRET` | **Historical** — CF Access service-token headers used when Sage was fronted by Cloudflare Access (pre-2026-08-01 Tencent era). Intra-host path drops them; the code still reads them if set. |
| `SOL_PRICE_USD` | static-price fallback (default 150). |
| `DRY_RUN` | **surfaced only as a HiveMind capability flag — NOT a gating var in the TS code.** |

> The old JS-era `DRY_RUN`-as-master-switch is gone. The gates are `MERIDIAN_CHAIN`
> + `MERIDIAN_WRITE_UNSAFE`. Production sets these in `docker-compose.yml`, not `.env`.

---

## Dashboard bridge (`src/adapters/dashboard/`)

A `node:http` server (zero external deps) bound to **`127.0.0.1` only** (never
`0.0.0.0`), token-authed. Started from `daemon.ts` when `DASHBOARD_ENABLED=true`.
- Routes: `GET /health`, `/state/positions` (`?force=1` throttled 1×/10s),
  `/state/summary`, `/state/file/:name` (whitelisted, `user-config` redacted; the
  `user-config` case reads via `ctx.configPath`, NOT `stateDir` — fixed 2026-08-02
  after the empty-stub-at-stateDir 404 bug), `/events` (SSE — piggybacks the
  PnL-poller cache, **no new RPC**), `POST /tool` (allowlist + write `confirm:true`
  + in-flight lock + optional `cycle_id` idempotency + human-gate on `update_config`),
  `POST /chat` (GENERAL tick, read-only via `CHAT_READ_TOOLS`).
- **`update_config` human-gate**: `POST /tool` with `name=update_config` AND a
  `cycle_id` returns 403 (`human-gated; not permitted inside a delegation cycle`).
  Only autonomous screening delegations attach `cycle_id`, so this hard-blocks
  Sage (or any Path 2 delegate) from patching config mid-cycle. User chats never
  carry a `cycle_id` → allowed. This is code-enforced, not prompt-enforced.
- **`cycle_id` idempotency** (`dashboard/idempotency.ts`): a write carrying a `cycle_id`
  commits the key on success; a later write with the same key → 409. Guards the Path 2
  delegate→timeout→fallback double-deploy on the bridge path (the bridge bypasses the
  agent once-per-session lock — see `inflight.ts`). Path 2's Sage deploys go through
  this `/tool` path, so all safety gates + post-hooks + the card notification still fire.
- **The Next.js web app** (`dashboard/web/`) is the only public surface. It talks to
  the bridge server-side only (token never reaches the browser) via same-origin
  `/api/*` proxies. PIN auth: `middleware.ts` (iron-session cookie) + `lib/auth-core.ts`
  (scrypt + constant-time + rate-limit). Deployment/auth details →
  `deploy/homeserver/README.md`.

---

## Telegram ops surface (`src/app/telegram/router.ts`)

`routeTelegramMessage` dispatches: read-only `/help /status /wallet /positions /briefing`;
cron control `/pause /resume /stop` (need `scheduler`/`shutdown` deps); write commands
`/close <n> /closeall /deploy <pool> [sol]` (gated on `deps.writesEnabled`). Free-form
text → GENERAL agent tick (`GENERAL_TOOLS`, `maxSteps:8`). **Auth (chat-id / user
allowlist) is upstream** (the inbound adapter), not in the router.

**Notify-only mode (production default)**: with `MERIDIAN_TELEGRAM_INBOUND=false` the
daemon never starts the inbound REPL — only posts outbound deploy/close cards. Since
2026-08-02 the token itself is Sage's (@SageHermesAnd_bot), so those cards appear from
the same bot that replies to you conversationally. Hermes is the sole `getUpdates` poller
on the shared token — flipping inbound back on would cause a 409 Conflict. Calisto bot
retired; env backups on the host at `~/meridian/.env.bak-sagebot-*`. See
[`deploy/SAGE-MERIDIAN-ROLLOUT.md`](deploy/SAGE-MERIDIAN-ROLLOUT.md).

---

## Known issues / gotchas (verified against the code)

- **`DRY_RUN` is not a gate** in TS — only `MERIDIAN_CHAIN` + `MERIDIAN_WRITE_UNSAFE`.
- **`GetPositionsOptions.wallet_address` is accepted but IGNORED by the Meteora adapter.**
  `client.ts` `fetchPositionsSnapshot` always builds the pubkey from `wallet.address`
  (the daemon's own keypair), so `get_wallet_positions({wallet_address: X})` silently
  returns OUR positions, not X's. Reading a foreign wallet goes through the
  `WalletWatcher` port (`adapters/market/meteora-wallet-watcher.ts`) instead — that is
  why follow-the-wallet does not reuse `getMyPositions`.
- **Config path vs web read-path divergence**: the daemon loads config from cwd
  (`/app/user-config.json`), but the web container reads `MERIDIAN_ROOT=/opt/data`.
  `docker-compose.yml` bind-mounts the same host config file into the web container
  at `/opt/data/user-config.json` (ro) so the Config page isn't blank — keep that
  mount in sync if either path moves.
- **Provider fallback / system-role / tool-choice retry are decorators, not wired by
  default** — `daemon.ts` uses `createOpenRouterLLMClient` directly. Wrap it if you need resilience.
- **`role` is label-only**; the `activeRegistry` ternary in the loop is a dead no-op —
  tool scoping happens through `toolFilter`/schema emission.
- **Config vs state root can diverge** (config uses cwd, repos use `MERIDIAN_STATE_DIR`).
- **`FILE_WHITELIST` + redaction are duplicated** in the bridge (`allowlist.ts`/`redact.ts`)
  and the web fs path (`dashboard/web/lib/files.ts`) — keep them in sync.
- **`patch-anchor.js` (postinstall) is mandatory on Node 22** or `@meteora-ag/dlmm`
  fails to load (anchor ESM directory-import + `BN` export). See
  `deploy/homeserver/README.md`.
- **Jupiter Price v6 is sunset** — code uses `lite-api.jup.ag/price/v3`; swap uses v6.
- **Deploys are single-side SOL only** (`planDeploy` throws otherwise); wide-range (>69
  bins) is multi-tx with different slippage units per path.
- **No `signal-weights` repo, no bin-array rent assert** (named in the legacy doc; never
  ported to TS).
- **`add_lesson` sanitizer does NOT strip `<` `>`** — lessons render into LLM prompts,
  never HTML, and comparators are load-bearing for TA rules ("1h ATR > 25%",
  "from_high < -30%"). Fixed 2026-08-10 after 2 Sage-authored lessons had their
  operators silently stripped. Whitespace + 500-char cap still applied.
- **`at_local_top` is snapshot-in-time**, not stateful — reports whether current close
  is within 2% of the max-high of the last `windowShort` candles. Retrospectives on
  closed positions read it as "is this pool at a local top RIGHT NOW", NOT "was it at
  entry". For historic entry context use `entry_technicals` on the PerformanceRecord
  (captured by `track-position` post-hook at deploy) — same 12 fields as the live
  compute, frozen at the entry timestamp.
- **`enrichTechnicals` in screening cycle is fail-open** (same contract as
  `enrichCandidates`) — a GT 429 or timeout drops the `technicals:` line for that
  candidate, does NOT block the cycle. Zero candidates surviving diligence still
  produces a `no_deploy` decision; zero surviving technicals still ships to the decider
  with an empty `technicals:` line. Sage's veto rules see empty as "unknown" — this is
  intentional (fail-open) but does mean a persistent GT outage hides the vetoes.
- **Config writes must NOT use rename — bind-mount inode detach (fixed 2026-08-29).**
  `user-config.json` is a single-file Docker bind mount. `writeJsonAtomic`'s temp+rename
  does NOT reliably EBUSY on overlayfs — `rename` SUCCEEDS by creating a NEW inode in the
  container's upper layer, silently detaching `/app/user-config.json` from the host file.
  Symptom: dashboard config saves apply in-memory (look saved) but the host file never
  changes → every restart reverts, and `meridian-web` (reads the host mount) shows stale.
  Fix: `writeJsonAtomic(path, data, {inPlace:true})` overwrites the existing inode via
  `copyFile` (O_TRUNC). `update_config` uses it. Regression test:
  `tests/unit/atomic-write.test.ts`. **Only single-file mounts need this** — dir-mounted
  state files (`/opt/data/*.json`) keep temp+rename (safer; rename stays within the dir).
- **New persisted-schema fields MUST be `.optional()` or `.default()`.** A REQUIRED new
  field breaks loading of pre-existing records (`.passthrough()` tolerates extra keys, not
  missing ones). Broke prod 2026-08-29: `consecutive_red_count` added as required →
  `state.json`/`lessons.json` `entry_technicals` (written earlier) failed with 266 Schema
  mismatch issues. Fixed with `.default(null)`. Watch: `schemas/kline.ts`,
  `schemas/position.ts`, `schemas/lesson.ts`, `schemas/config*.ts`.

---

## Patterns to copy

- **New on-chain read** → copy the cache + inflight-dedup + `force` pattern from
  `chain/meteora/client.ts` `getMyPositions`. `force:true` is what safety gates rely on.
- **New persistent store** → copy a repo from `persistence/json/` (factory over a file
  path, `writeJsonAtomic`, Zod-validated read, `Result` return). Cap any growing array.
  New schema fields → `.optional()`/`.default()` (back-compat). Writing a single-file
  bind mount → `writeJsonAtomic {inPlace:true}`.
- **New Sage delegation** (screening decider vs exit advisor) → copy the transport from
  `adapters/llm/sage-decider-http.ts` / `sage-exit-advisor-http.ts` (CF/UA headers,
  `SageTransportError`, injectable `FetchLike`) + a fake double; wire it in `daemon.ts`
  gated on `SAGE_BASE_URL`+`SAGE_API_KEY`, only USED behind a config flag.
- **New tool** → `defineTool` with Zod args/result + safety gates + post hooks; never
  throw, return `ToolError`.
- **New scheduled work** → `scheduler.every(ms, job, label)` (overlap-skip is built in);
  add teardown to the shutdown sequence in `daemon.ts`.
- **New pre-LLM enrichment** → cheap checks first (in-memory/file), then network, each
  pass/reject logged with a stage name (see `rules/screening.ts` `hardFilter`).

---

## What to read next

- Add a tool → `src/app/tools/impls/`, `tools/registry.ts`, `domain/prompt/role-tools.ts`.
- Change safety/exit rules → `src/domain/rules/close-rules.ts` + `tools/safety/*`.
- Change the smart-exit engine → `src/domain/rules/close-rules.ts` (`getExitDecision` /
  `getPollerFastCut`) + `src/app/management/cycle.ts` (`resolveEscalation`) + `pnl-poller.ts`;
  design in [`deploy/SPEC-2026-08-29-smart-exit-regime-engine.md`](deploy/SPEC-2026-08-29-smart-exit-regime-engine.md).
- Change what Sage knows (screening OR exit-advisor prompts/behavior) →
  `deploy/hermes-meridian-plugin/skill/SKILL.md` — **only relevant when Sage is wired
  up; it is disabled on the current homeserver** (**pull the live copy from vivobook
  FIRST — Sage self-edits it**; deploy steps in that plugin's README) + Sage's SOUL.md on
  the box. The per-request exit prompt Meridian sends is `EXIT_ADVISOR_PROMPT` in
  `src/app/management/cycle.ts`.
- Change follow-the-wallet → `src/domain/rules/follow-diff.ts` (pure diff/sizing/range) +
  `src/app/follow/cycle.ts` + `src/app/follow/learn.ts` +
  `src/adapters/market/meteora-wallet-watcher.ts`.
- Change the LLM contract → `src/app/agent/loop.ts` + `domain/prompt/builder.ts`.
- Change deploy/close on-chain behavior → `src/adapters/chain/meteora/write-paths.ts` +
  `client.ts` (post-tool side-effects are in `tools/post/*`).
- Config schema → `src/domain/schemas/config*.ts` + `config-load.ts`.
- Dashboard/bridge → `src/adapters/dashboard/` + `dashboard/web/`.
- **Deployment / ops / secrets / troubleshooting →
  [`deploy/homeserver/README.md`](deploy/homeserver/README.md)** (the vivobook-era
  `deploy/OPERATIONS.md` is historical).
