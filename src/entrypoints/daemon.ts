// MUST stay the first import — ESM evaluates imported modules in order and all of
// them before this module's own statements, so a bare `config()` call placed here
// would run too late. See load-env.ts for why this is a no-op in production.
import "./load-env.js";

import path from "node:path";
import { fixedClock, systemClock } from "../ports/clock.js";
import { createConsoleLogger } from "../adapters/logger/console.js";
import { createRingBufferLogger, type LogStore } from "../adapters/logger/ring-buffer-logger.js";
import { createJsonPositionRepo } from "../adapters/persistence/json/position-repo.js";
import { createJsonPoolMemoryRepo } from "../adapters/persistence/json/pool-memory-repo.js";
import { createJsonConfigRepo } from "../adapters/persistence/json/config-repo.js";
import { createJsonLessonRepo } from "../adapters/persistence/json/lesson-repo.js";
import { createJsonDecisionLog } from "../adapters/persistence/json/decision-log.js";
import { createJsonStrategyRepo } from "../adapters/persistence/json/strategy-repo.js";
import { createJsonSmartWalletRepo } from "../adapters/persistence/json/smart-wallet-repo.js";
import { createJsonTokenBlacklistRepo } from "../adapters/persistence/json/token-blacklist-repo.js";
import { createJsonDevBlocklistRepo } from "../adapters/persistence/json/dev-blocklist-repo.js";
import { createDryRunChainClient } from "../adapters/chain/dry-run.js";
import { createMeteoraChainClient } from "../adapters/chain/meteora/client.js";
import { createSolanaConnection, loadWalletKeypair } from "../adapters/chain/meteora/connection.js";
import { createStaticPriceOracle } from "../adapters/market/static-price-oracle.js";
import { createJupiterPriceOracle } from "../adapters/market/jupiter-price-oracle.js";
import { createGeckoTerminalKlineClient } from "../adapters/market/geckoterminal-kline.js";
import { createFakeKlineClient } from "../adapters/market/fake-kline.js";
import { createJupiterSwapClient } from "../adapters/swap/jupiter-swap.js";
import { createMeteoraDatapiPnlFetcher } from "../adapters/chain/meteora/datapi-pnl.js";
import type { ChainClient } from "../ports/chain-client.js";
import type { PriceOracle } from "../ports/price-oracle.js";
import type { SwapClient } from "../ports/swap-client.js";
import { createOpenRouterLLMClient } from "../adapters/llm/openrouter.js";
import { createFakeLLM } from "../adapters/llm/fake.js";
import { createSageDeciderHttp } from "../adapters/llm/sage-decider-http.js";
import { createSageExitAdvisorHttp } from "../adapters/llm/sage-exit-advisor-http.js";
import type { SageExitAdvisor } from "../ports/sage-exit-advisor.js";
import type { SageDecider } from "../ports/sage-decider.js";
import { createCollectingNotifier } from "../adapters/notify/collecting-notifier.js";
import { createTelegramNotifier } from "../adapters/notify/telegram.js";
import type { Notifier } from "../ports/notifier.js";
import { createFakePoolDiscovery } from "../adapters/market/fake-pool-discovery.js";
import { createFakeTokenInfo } from "../adapters/market/fake-token-info.js";
import { createFakeRugCheck } from "../adapters/market/fake-rug-check.js";
import { createFakeSmartWalletChecker } from "../adapters/market/fake-smart-wallet-checker.js";
import { createMeteoraPoolDiscovery } from "../adapters/market/meteora-pool-discovery.js";
import { createJupiterTokenInfo } from "../adapters/market/jupiter-token-info.js";
import { createRugcheckAdapter } from "../adapters/market/rugcheck.js";
import { createMeteoraSmartWalletChecker } from "../adapters/market/meteora-smart-wallet-checker.js";
import { createAgentMeridianStudy } from "../adapters/market/agent-meridian-study.js";
import { createFakeStudy } from "../adapters/market/fake-study.js";
import type { PoolDiscoveryClient } from "../ports/pool-discovery.js";
import type { TokenInfoClient } from "../ports/token-info-client.js";
import type { RugCheckClient } from "../ports/rug-check.js";
import type { SmartWalletChecker } from "../ports/smart-wallet-checker.js";
import { createRegistry } from "../app/tools/registry.js";
import { getPoolMemoryTool } from "../app/tools/impls/get-pool-memory.js";
import { assertPoolDeployableTool } from "../app/tools/impls/assert-pool-deployable.js";
import { getWalletBalanceTool } from "../app/tools/impls/get-wallet-balance.js";
import { getActiveBinTool } from "../app/tools/impls/get-active-bin.js";
import { getMyPositionsTool } from "../app/tools/impls/get-my-positions.js";
import { getRecentDecisionsTool } from "../app/tools/impls/get-recent-decisions.js";
import { listBlacklistTool } from "../app/tools/impls/list-blacklist.js";
import { listSmartWalletsTool } from "../app/tools/impls/list-smart-wallets.js";
import { getActiveStrategyTool } from "../app/tools/impls/get-active-strategy.js";
import { deployPositionTool } from "../app/tools/impls/deploy-position.js";
import { closePositionTool } from "../app/tools/impls/close-position.js";
import { claimFeesTool } from "../app/tools/impls/claim-fees.js";
import { swapTokenTool } from "../app/tools/impls/swap-token.js";
import { addToBlacklistTool } from "../app/tools/impls/add-to-blacklist.js";
import { searchPoolsTool } from "../app/tools/impls/search-pools.js";
import { getTokenInfoTool } from "../app/tools/impls/get-token-info.js";
import { getTokenHoldersTool } from "../app/tools/impls/get-token-holders.js";
import { getTokenNarrativeTool } from "../app/tools/impls/get-token-narrative.js";
import { checkSmartWalletsOnPoolTool } from "../app/tools/impls/check-smart-wallets-on-pool.js";
import { getTopCandidatesTool } from "../app/tools/impls/get-top-candidates.js";
import { getPositionPnlTool } from "../app/tools/impls/get-position-pnl.js";
import { getWalletPositionsTool } from "../app/tools/impls/get-wallet-positions.js";
import { getPoolDetailTool } from "../app/tools/impls/get-pool-detail.js";
import { getPoolKlineTool } from "../app/tools/impls/get-pool-kline.js";
import { getPerformanceHistoryTool } from "../app/tools/impls/get-performance-history.js";
import { listLessonsTool } from "../app/tools/impls/list-lessons.js";
import { listStrategiesTool } from "../app/tools/impls/list-strategies.js";
import { listBlockedDeployersTool } from "../app/tools/impls/list-blocked-deployers.js";
import { discoverPoolsTool } from "../app/tools/impls/discover-pools.js";
import { setPositionNoteTool } from "../app/tools/impls/set-position-note.js";
import { addLessonTool } from "../app/tools/impls/add-lesson.js";
import { pinLessonTool } from "../app/tools/impls/pin-lesson.js";
import { unpinLessonTool } from "../app/tools/impls/unpin-lesson.js";
import { clearLessonsTool } from "../app/tools/impls/clear-lessons.js";
import { addStrategyTool } from "../app/tools/impls/add-strategy.js";
import { removeStrategyTool } from "../app/tools/impls/remove-strategy.js";
import { setActiveStrategyTool } from "../app/tools/impls/set-active-strategy.js";
import { updateConfigTool } from "../app/tools/impls/update-config.js";
import { removeFromBlacklistTool } from "../app/tools/impls/remove-from-blacklist.js";
import { addSmartWalletTool } from "../app/tools/impls/add-smart-wallet.js";
import { removeSmartWalletTool } from "../app/tools/impls/remove-smart-wallet.js";
import { blockDeployerTool } from "../app/tools/impls/block-deployer.js";
import { unblockDeployerTool } from "../app/tools/impls/unblock-deployer.js";
import { getTopLpersTool } from "../app/tools/impls/get-top-lpers.js";
import { studyTopLpersTool } from "../app/tools/impls/study-top-lpers.js";
import type { AppContext } from "../app/tools/context.js";
import type { LLMClient } from "../ports/llm-client.js";
import type { AppConfig } from "../domain/schemas/config.js";
import { createIntervalScheduler } from "../adapters/scheduler/interval.js";
import { runScreeningCycle } from "../app/screening/cycle.js";
import { runManagementCycle } from "../app/management/cycle.js";
import { createPnlPoller } from "../app/management/pnl-poller.js";
import { createDustSweeper } from "../app/management/dust-sweeper.js";
import { runBriefingCycle } from "../app/briefing/cycle.js";
import { runHealthCycle } from "../app/health/cycle.js";
import { createAgentMeridianHiveMind } from "../adapters/hivemind/agent-meridian.js";
import { createHiveMindSync } from "../app/hivemind/sync.js";
import { createTelegramInbound } from "../adapters/notify/telegram-inbound.js";
import { routeTelegramMessage } from "../app/telegram/router.js";

const REPO_ROOT = process.cwd();
const STATE_DIR = process.env.MERIDIAN_STATE_DIR
  ? path.resolve(process.env.MERIDIAN_STATE_DIR)
  : REPO_ROOT;

const ALL_TOOLS = [
  getPoolMemoryTool,
  assertPoolDeployableTool,
  getWalletBalanceTool,
  getActiveBinTool,
  getMyPositionsTool,
  getRecentDecisionsTool,
  listBlacklistTool,
  listSmartWalletsTool,
  getActiveStrategyTool,
  deployPositionTool,
  closePositionTool,
  claimFeesTool,
  swapTokenTool,
  addToBlacklistTool,
  searchPoolsTool,
  getTokenInfoTool,
  getTokenHoldersTool,
  getTokenNarrativeTool,
  checkSmartWalletsOnPoolTool,
  getTopCandidatesTool,
  // Dashboard control surface — read tools
  getPositionPnlTool,
  getWalletPositionsTool,
  getPoolDetailTool,
  getPoolKlineTool,
  getPerformanceHistoryTool,
  listLessonsTool,
  listStrategiesTool,
  listBlockedDeployersTool,
  discoverPoolsTool,
  // Dashboard control surface — write tools
  setPositionNoteTool,
  addLessonTool,
  pinLessonTool,
  unpinLessonTool,
  clearLessonsTool,
  addStrategyTool,
  removeStrategyTool,
  setActiveStrategyTool,
  updateConfigTool,
  removeFromBlacklistTool,
  addSmartWalletTool,
  removeSmartWalletTool,
  blockDeployerTool,
  unblockDeployerTool,
  getTopLpersTool,
  studyTopLpersTool,
];

interface BootResult {
  config: AppConfig;
  ctx: AppContext;
  llm: LLMClient;
  usingDemoLLM: boolean;
  logStore: LogStore;
}

async function boot(): Promise<BootResult> {
  // Tee console logs into an in-memory ring so the dashboard /logs page can tail
  // the daemon's own output (the web container can't read the daemon's PM2 files).
  const { logger, store: logStore } = createRingBufferLogger(createConsoleLogger("info"));
  const clock = process.env.MERIDIAN_FROZEN_TIME
    ? fixedClock(process.env.MERIDIAN_FROZEN_TIME)
    : systemClock;

  const primaryConfigPath = path.join(REPO_ROOT, "user-config.json");
  const configRepo = createJsonConfigRepo({ filePath: primaryConfigPath });
  let cfg = await configRepo.load();
  if (!cfg.ok && cfg.error.kind === "load" && cfg.error.error.kind === "not_found") {
    const examplePath = path.join(REPO_ROOT, "user-config.example.json");
    logger.warn("boot", `user-config.json not found, falling back to ${examplePath}`);
    cfg = await createJsonConfigRepo({ filePath: examplePath }).load();
  }
  if (!cfg.ok) {
    throw new Error(
      `Failed to load user-config.json: ${cfg.error.kind}${
        cfg.error.kind === "load" ? ` (${cfg.error.error.kind})` : ""
      }`,
    );
  }

  const positions = createJsonPositionRepo({ filePath: path.join(STATE_DIR, "state.json"), clock, logger });
  const poolMemory = createJsonPoolMemoryRepo({ filePath: path.join(STATE_DIR, "pool-memory.json"), logger });
  const lessons = createJsonLessonRepo({ filePath: path.join(STATE_DIR, "lessons.json"), logger });
  const decisions = createJsonDecisionLog({ filePath: path.join(STATE_DIR, "decision-log.json"), logger });
  const strategies = createJsonStrategyRepo({ filePath: path.join(STATE_DIR, "strategy-library.json"), logger });
  const smartWallets = createJsonSmartWalletRepo({ filePath: path.join(STATE_DIR, "smart-wallets.json"), logger });
  const tokenBlacklist = createJsonTokenBlacklistRepo({ filePath: path.join(STATE_DIR, "token-blacklist.json"), logger });
  const devBlocklist = createJsonDevBlocklistRepo({ filePath: path.join(STATE_DIR, "dev-blocklist.json"), logger });

  const chainMode = (process.env.MERIDIAN_CHAIN ?? "dryrun").toLowerCase();
  const priceMode = (
    process.env.MERIDIAN_PRICE ?? (chainMode === "meteora" ? "jupiter" : "static")
  ).toLowerCase();
  const staticPrice = Number(process.env.SOL_PRICE_USD ?? 150);

  function buildPriceOracle(): PriceOracle {
    if (priceMode === "jupiter") {
      return createJupiterPriceOracle({
        clock,
        logger,
        fallbackUsd: Number.isFinite(staticPrice) && staticPrice > 0 ? staticPrice : 150,
      });
    }
    if (priceMode !== "static") {
      throw new Error(`MERIDIAN_PRICE unknown: ${priceMode} (expected "jupiter" or "static")`);
    }
    return createStaticPriceOracle(staticPrice);
  }
  const price = buildPriceOracle();
  logger.info("boot", `price: ${priceMode}`);

  let chain: ChainClient;
  let swap: SwapClient;
  // Late-bound base-mint → symbol resolver; assigned once tokenInfo is selected
  // below so the meteora chain can label positions Wukong/SOL instead of F4Tn/SOL.
  let resolveTokenSymbol: ((mint: string) => Promise<string | null>) | null = null;
  if (chainMode === "meteora") {
    const rpc = process.env.RPC_URL;
    const secret = process.env.WALLET_PRIVATE_KEY;
    if (!rpc) throw new Error("MERIDIAN_CHAIN=meteora requires RPC_URL");
    if (!secret) throw new Error("MERIDIAN_CHAIN=meteora requires WALLET_PRIVATE_KEY");
    const [connection, wallet] = await Promise.all([
      createSolanaConnection(rpc),
      loadWalletKeypair(secret),
    ]);
    const pnl = createMeteoraDatapiPnlFetcher({ logger });
    const writesEnabled = process.env.MERIDIAN_WRITE_UNSAFE === "true";
    if (writesEnabled) {
      logger.warn(
        "boot",
        "MERIDIAN_WRITE_UNSAFE=true — real Meteora write paths ARMED. Real SOL can move.",
      );
    }
    // Late-bound so positions show token symbols (Wukong/SOL) not mint prefixes.
    // tokenInfo is selected below; getMyPositions only runs post-boot, by which
    // point resolveTokenSymbol is assigned.
    chain = createMeteoraChainClient({
      connection,
      wallet,
      price,
      clock,
      logger,
      pnl,
      symbolResolver: (mint) => (resolveTokenSymbol ? resolveTokenSymbol(mint) : Promise.resolve(null)),
      solMode: cfg.value.management.solMode,
      pnlMaxDiffPct: cfg.value.management.pnlSanityMaxDiffPct,
      writesEnabled,
    });
    const referralAccount =
      process.env.JUPITER_REFERRAL_ACCOUNT ?? cfg.value.jupiter.referralAccount;
    const referralFeeBps = process.env.JUPITER_REFERRAL_FEE_BPS
      ? Number(process.env.JUPITER_REFERRAL_FEE_BPS)
      : cfg.value.jupiter.referralFeeBps;
    swap = createJupiterSwapClient({
      clock,
      logger,
      wallet,
      connection,
      ...(referralAccount ? { referralAccount } : {}),
      ...(referralFeeBps ? { referralFeeBps } : {}),
    });
    logger.info("boot", `chain: meteora (wallet=${wallet.address.slice(0, 8)}...)`);
  } else {
    chain = createDryRunChainClient({ clock, seed: { walletSol: 5 } });
    swap = {
      async swap(args: import("../domain/schemas/chain.js").SwapArgs) {
        return {
          success: true,
          input_mint: args.input_mint,
          output_mint: args.output_mint,
          amount_in: args.amount_in,
          amount_out: args.amount_in,
          tx: "daemon-fake-swap",
          dry_run: true,
        };
      },
    };
    logger.info("boot", "chain: dryrun");
  }
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const notifier: Notifier =
    telegramToken && telegramChatId
      ? createTelegramNotifier({ botToken: telegramToken, chatId: telegramChatId, logger })
      : createCollectingNotifier();
  logger.info("boot", `notifier: ${telegramToken && telegramChatId ? "telegram" : "collecting"}`);

  const marketMode = (
    process.env.MERIDIAN_MARKET ?? (chainMode === "meteora" ? "real" : "fake")
  ).toLowerCase();
  if (marketMode !== "real" && marketMode !== "fake") {
    throw new Error(`MERIDIAN_MARKET unknown: ${marketMode} (expected "real" or "fake")`);
  }
  const nowFn = (): Date => clock.now();
  const pools: PoolDiscoveryClient =
    marketMode === "real"
      ? createMeteoraPoolDiscovery({
          logger,
          screening: cfg.value.screening,
          now: nowFn,
        })
      : createFakePoolDiscovery({
          seed: [
            {
              pool_address: "DemoPool111111111111111111111111111111111111",
              name: "DEMO/SOL",
              base_mint: "DemoMint11111111111111111111111111111111111",
              quote_mint: "So11111111111111111111111111111111111111112",
              tvl: 50_000,
              active_tvl: 40_000,
              volume_window: 25_000,
              fee_active_tvl_ratio: 0.12,
              fee_tvl_ratio: 0.1,
              organic_score: 75,
              holders: 1200,
              mcap: 400_000,
              bin_step: 100,
              volatility: 0.08,
              launchpad: null,
              token_age_hours: 48,
              active_pct: 65,
            },
          ],
        });
  const tokenInfo: TokenInfoClient =
    marketMode === "real"
      ? createJupiterTokenInfo({ logger, now: nowFn })
      : createFakeTokenInfo();
  // Wire the late-bound symbol resolver now that tokenInfo exists (meteora chain reads it).
  resolveTokenSymbol = (mint) => tokenInfo.getInfo(mint).then((i) => i.symbol ?? null).catch(() => null);
  const rugCheck: RugCheckClient =
    marketMode === "real" ? createRugcheckAdapter({ logger }) : createFakeRugCheck();
  const smartWalletChecker: SmartWalletChecker =
    marketMode === "real"
      ? createMeteoraSmartWalletChecker({
          logger,
          clock,
          loadWallets: async () => {
            const list = await smartWallets.list();
            return list.map(({ addedAt: _drop, ...rest }) => ({
              ...rest,
              addedAt: _drop,
            }));
          },
          tokenInfo,
        })
      : createFakeSmartWalletChecker();
  const study =
    marketMode === "real"
      ? createAgentMeridianStudy({
          logger,
          baseUrl: cfg.value.api.url,
          ...(cfg.value.api.publicApiKey ? { apiKey: cfg.value.api.publicApiKey } : {}),
        })
      : createFakeStudy();
  const kline =
    marketMode === "real"
      ? createGeckoTerminalKlineClient({ clock, logger })
      : createFakeKlineClient();
  const market = {
    pools,
    tokenInfo,
    rugCheck,
    smartWalletChecker,
    study,
    kline,
  };
  logger.info("boot", `market: ${marketMode}`);

  const ctx: AppContext = {
    clock,
    logger,
    config: cfg.value,
    configPath: primaryConfigPath,
    chain,
    swap,
    notifier,
    market,
    repos: { positions, poolMemory, lessons, decisions, strategies, smartWallets, tokenBlacklist, devBlocklist },
  };

  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;
  const useDemo = process.env.MERIDIAN_DEMO === "true" || !apiKey;
  const llm: LLMClient = useDemo
    ? createFakeLLM({
        script: [
          // Screener demo: full pipeline — top candidates → assert deployable → deploy → verify
          { kind: "tool_calls", calls: [{ name: "get_wallet_balance", args: {} }] },
          { kind: "tool_calls", calls: [{ name: "get_top_candidates", args: { limit: 3 } }] },
          { kind: "tool_calls", calls: [{ name: "assert_pool_deployable", args: { pool_address: "DemoPool111111111111111111111111111111111111", base_mint: "DemoMint11111111111111111111111111111111111" } }] },
          {
            kind: "tool_calls",
            calls: [
              {
                name: "deploy_position",
                args: {
                  pool_address: "DemoPool111111111111111111111111111111111111",
                  amount_sol: 0.5,
                  strategy: "bid_ask",
                  bins_below: 40,
                  bins_above: 10,
                  pool_name: "DEMO/SOL",
                  base_mint: "DemoMint11111111111111111111111111111111111",
                },
              },
            ],
          },
          { kind: "tool_calls", calls: [{ name: "get_my_positions", args: { force: true } }] },
          { kind: "assistant", text: "Screened 1 candidate, DEMO/SOL passed all filters. Deployed 0.5 SOL (bid_ask, 40 bins below)." },
        ],
        model: "demo/fake-v1",
      })
    : createOpenRouterLLMClient({
        apiKey,
        ...(process.env.LLM_BASE_URL ? { baseURL: process.env.LLM_BASE_URL } : {}),
      });

  return { config: cfg.value, ctx, llm, usingDemoLLM: useDemo, logStore };
}

async function main(): Promise<void> {
  const banner = "meridian-ts skeleton";
  const startedAt = new Date().toISOString();

  const boot0 = await boot().catch((e: unknown) => {
    console.error(`${banner}: boot failed:`, e);
    process.exit(1);
  });
  const { ctx, llm, usingDemoLLM, logStore } = boot0;

  console.log(`${banner} boot ok @ ${startedAt}`);
  console.log(`  llm: ${usingDemoLLM ? "fake (demo)" : "openrouter"}`);
  console.log(`  max positions: ${ctx.config.risk.maxPositions}`);
  console.log(`  strategy: ${ctx.config.strategy.strategy} bins=${ctx.config.strategy.binsBelow}`);

  const walletAtBoot = await ctx.chain.getWalletBalance();
  console.log(`  wallet: ${walletAtBoot.sol} SOL ($${walletAtBoot.sol_usd})`);

  const registry = createRegistry(ALL_TOOLS);
  // Per-role model selection. `LLM_MODEL` env (single global) still overrides for
  // ops/debug; in demo mode the fake client's model id is used; otherwise each cycle
  // reads its role's configured model live from ctx.config (so dashboard model edits
  // hot-reload). Fixes the prod outage where an unset LLM_MODEL fell back to the fake
  // id "demo/fake-v1" and every real screening LLM call 400'd.
  const modelFor = (role: "screening" | "management" | "general"): string => {
    if (process.env.LLM_MODEL) return process.env.LLM_MODEL;
    if (usingDemoLLM) return "demo/fake-v1";
    const llm = ctx.config.llm;
    if (role === "screening") return llm.screeningModel;
    if (role === "management") return llm.managementModel;
    return llm.generalModel;
  };

  // ── Sage delegation — Sage is the final authority whenever creds are present.
  // Enabled automatically when SAGE_BASE_URL + SAGE_API_KEY are set. Opt out
  // explicitly with MERIDIAN_DECIDER=loop (kept for local debugging / dry runs).
  // Prior behaviour required BOTH the env keys AND MERIDIAN_DECIDER=sage — the
  // opt-in was silently absent in production, so the "screener SCREENER actor"
  // path fell back to the local LLM loop and mechanically redeployed a token
  // the user had just closed at -8.29% (2026-08-11 incident).
  const sageEnabled = process.env.MERIDIAN_DECIDER !== "loop" && !!process.env.SAGE_BASE_URL && !!process.env.SAGE_API_KEY;
  const sageDecider: SageDecider | undefined =
    sageEnabled
      ? createSageDeciderHttp({
          baseUrl: process.env.SAGE_BASE_URL!,
          apiKey: process.env.SAGE_API_KEY!,
          ...(process.env.SAGE_MODEL ? { model: process.env.SAGE_MODEL } : {}),
          ...(process.env.SAGE_CF_ACCESS_CLIENT_ID && process.env.SAGE_CF_ACCESS_CLIENT_SECRET
            ? {
                cfAccessClientId: process.env.SAGE_CF_ACCESS_CLIENT_ID,
                cfAccessClientSecret: process.env.SAGE_CF_ACCESS_CLIENT_SECRET,
              }
            : {}),
        })
      : undefined;
  const screeningExtra = sageDecider
    ? {
        decider: "sage" as const,
        sage: sageDecider,
        sageSessionKey: process.env.SAGE_SESSION_KEY ?? "meridian-trading",
        sageTimeoutMs: Number(process.env.SAGE_TIMEOUT_MS ?? 90_000),
      }
    : {};
  if (sageDecider) console.log(`  decider: SAGE (${process.env.SAGE_BASE_URL}) — local loop fallback armed`);

  // Sage EXIT advisor — same Hermes endpoint, advisory (returns CLOSE/HOLD, no
  // writes). Created whenever Sage env is present; only consulted when
  // management.sageExitEnabled=true (dark by default). Escalations for AMBIGUOUS
  // exits go here; on transport failure the management cycle applies its
  // conditional deterministic fallback.
  const sageExitAdvisor: SageExitAdvisor | undefined =
    process.env.SAGE_BASE_URL && process.env.SAGE_API_KEY
      ? createSageExitAdvisorHttp({
          baseUrl: process.env.SAGE_BASE_URL,
          apiKey: process.env.SAGE_API_KEY,
          ...(process.env.SAGE_MODEL ? { model: process.env.SAGE_MODEL } : {}),
          ...(process.env.SAGE_CF_ACCESS_CLIENT_ID && process.env.SAGE_CF_ACCESS_CLIENT_SECRET
            ? {
                cfAccessClientId: process.env.SAGE_CF_ACCESS_CLIENT_ID,
                cfAccessClientSecret: process.env.SAGE_CF_ACCESS_CLIENT_SECRET,
              }
            : {}),
        })
      : undefined;
  const managementExtra = sageExitAdvisor
    ? {
        sageExit: sageExitAdvisor,
        sageSessionKey: process.env.SAGE_SESSION_KEY ?? "meridian-trading",
        sageTimeoutMs: Number(process.env.SAGE_EXIT_TIMEOUT_MS ?? 30_000),
      }
    : {};
  if (ctx.config.management.smartExitEnabled) {
    console.log(
      `  smart-exit: ENABLED (floor ${ctx.config.management.exitHardFloorPct}%, sageExit ${ctx.config.management.sageExitEnabled ? "on" : "off"})`,
    );
  }

  // ── Dashboard bridge (env-gated; the ONLY dashboard touch-point in core) ──
  // Without DASHBOARD_ENABLED=true the bridge module is never even imported, so daemon
  // behavior is byte-for-byte identical. Placed before the autonomous/one-shot split so
  // the bridge is available in both modes. Startup failure MUST NOT stop the daemon.
  let dashboardBridge: { close: () => Promise<void> } | null = null;
  if (process.env.DASHBOARD_ENABLED === "true") {
    try {
      const { startBridge } = await import("../adapters/dashboard/server.js");
      dashboardBridge = startBridge({
        port: Number(process.env.DASHBOARD_PORT ?? 8787),
        token: process.env.DASHBOARD_TOKEN,
        ctx,
        llm,
        registry,
        model: modelFor("general"),
        stateDir: STATE_DIR,
        logStore,
      });
    } catch (e) {
      ctx.logger.warn(
        "dashboard",
        `Bridge failed to start: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (process.env.MERIDIAN_AUTONOMOUS === "true") {
    console.log(`\n──── AUTONOMOUS mode ────`);
    const scheduler = createIntervalScheduler(ctx.logger);
    const screenMs = ctx.config.schedule.screeningIntervalMin * 60_000;
    const manageMs = ctx.config.schedule.managementIntervalMin * 60_000;
    console.log(`  screening every ${screenMs / 1000}s | management every ${manageMs / 1000}s`);
    scheduler.every(screenMs, () => runScreeningCycle({ ctx, llm, registry, model: modelFor("screening"), ...screeningExtra }).then(() => {}), "screening");
    scheduler.every(manageMs, () => runManagementCycle({ ctx, registry, ...managementExtra }).then(() => {}), "management");
    const pollerHandle = createPnlPoller({
      clock: ctx.clock,
      logger: ctx.logger,
      chain: ctx.chain,
      swap: ctx.swap,
      notifier: ctx.notifier,
      scheduler,
      positionRepo: ctx.repos.positions,
      config: ctx.config.management,
    });
    console.log("  pnl-poller: 30s trailing-TP + 15s two-phase confirm");

    if (ctx.config.management.dustSweepEnabled) {
      const sweepMs = ctx.config.management.dustSweepIntervalMin * 60_000;
      createDustSweeper({
        clock: ctx.clock,
        logger: ctx.logger,
        chain: ctx.chain,
        swap: ctx.swap,
        notifier: ctx.notifier,
        scheduler,
        intervalMs: sweepMs,
        minUsd: ctx.config.management.dustSweepMinUsd,
        slippageBps: ctx.config.management.dustSweepSlippageBps,
      });
      console.log(
        `  dust-sweeper: every ${sweepMs / 1000}s — sells any non-SOL wallet token above $${ctx.config.management.dustSweepMinUsd} not held by an open position`,
      );
    } else {
      console.log("  dust-sweeper: disabled (management.dustSweepEnabled=false)");
    }

    const healthMs = ctx.config.schedule.healthCheckIntervalMin * 60_000;
    scheduler.every(
      healthMs,
      () =>
        runHealthCycle({ ctx, llm, registry, model: modelFor("management") }).then(() => {}).catch((err: unknown) => {
          ctx.logger.warn("health", "cycle failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      "health",
    );
    console.log(`  health-check: every ${healthMs / 1000}s`);

    const briefingIntervalMs = 24 * 3_600_000;
    scheduler.every(
      briefingIntervalMs,
      () =>
        runBriefingCycle({ ctx }).then(() => {}).catch((err: unknown) => {
          ctx.logger.warn("briefing", "cycle failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      "briefing",
    );
    console.log("  briefing: every 24h");

    const hive = createAgentMeridianHiveMind({
      logger: ctx.logger,
      clock: ctx.clock,
      enabled: !!ctx.config.hiveMind.agentId && ctx.config.hiveMind.pullMode !== "manual",
      agentId: ctx.config.hiveMind.agentId,
      ...(ctx.config.hiveMind.apiKey ? { apiKey: ctx.config.hiveMind.apiKey } : {}),
      baseUrl: ctx.config.hiveMind.url,
      version: "meridian-ts",
      capabilities: () => ({
        chain: process.env.MERIDIAN_CHAIN ?? "dryrun",
        market: process.env.MERIDIAN_MARKET ?? "fake",
        writes_armed: process.env.MERIDIAN_WRITE_UNSAFE === "true",
        dry_run: process.env.DRY_RUN === "true",
      }),
    });
    const hiveSync = createHiveMindSync({
      clock: ctx.clock,
      logger: ctx.logger,
      scheduler,
      client: hive,
    });
    if (hive.isEnabled()) {
      console.log("  hivemind-sync: every 15m (agent-meridian)");
    } else {
      console.log("  hivemind-sync: disabled (no agentId or manual pull mode)");
    }
    const shutdownHive = hiveSync.stop;

    let shutdownInbound: () => void = () => {};
    let shuttingDown = false;
    const shutdown = (sig: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n${sig} — shutting down scheduler`);
      pollerHandle.stop();
      shutdownHive();
      shutdownInbound();
      if (dashboardBridge) void dashboardBridge.close();
      scheduler.cancelAll();
      process.exit(0);
    };
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;
    const telegramAllowed = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // MERIDIAN_TELEGRAM_INBOUND=false → Calisto is a STATIC notify-only bot: it still
    // posts deploy/close cards (the outbound notifier is separate) but never replies to
    // messages / runs the GENERAL LLM. Use this when Sage is the sole conversational brain
    // in the group. Default (unset) keeps the inbound REPL for backward compatibility.
    const inboundEnabled = process.env.MERIDIAN_TELEGRAM_INBOUND !== "false";
    if (telegramToken && telegramChatId && inboundEnabled) {
      const inbound = createTelegramInbound({
        logger: ctx.logger,
        botToken: telegramToken,
        chatId: telegramChatId,
        allowedUserIds: telegramAllowed,
      });
      const handle = inbound.start(async (msg) => {
        try {
          await routeTelegramMessage(
            {
              ctx,
              llm,
              registry,
              model: modelFor("general"),
              scheduler,
              shutdown,
              writesEnabled: process.env.MERIDIAN_WRITE_UNSAFE === "true",
            },
            msg,
          );
        } catch (err) {
          ctx.logger.warn("telegram-router", "route threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
      shutdownInbound = handle.stop;
      console.log("  telegram-inbound: long-poll REPL armed");
    } else if (telegramToken && telegramChatId && !inboundEnabled) {
      console.log("  telegram-inbound: disabled (MERIDIAN_TELEGRAM_INBOUND=false — Calisto is notify-only; Sage is the brain)");
    } else {
      console.log("  telegram-inbound: disabled (no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
    }
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    console.log("(Ctrl+C to stop)");
    return;
  }

  // One-shot mode — run one screening cycle for demo.
  const outcome = await runScreeningCycle({ ctx, llm, registry, model: modelFor("screening"), ...screeningExtra });
  console.log("\n─── screening cycle ───");
  console.log(`outcome: ${outcome.kind}`);
  if (outcome.kind === "invoked") {
    const { agent } = outcome;
    console.log(`agent finish: ${agent.finishReason}  steps: ${agent.steps}  locks: [${agent.locks.join(", ")}]`);
    for (const t of agent.toolCalls) {
      console.log(`  · step ${t.step + 1}: ${t.name} ok=${t.ok}`);
    }
    console.log(`text: ${agent.text}`);
  } else if (outcome.kind === "no_deploy") {
    console.log(`  rejection_summary: ${outcome.rejection_summary.join(", ")}`);
  } else if (outcome.kind === "skipped") {
    console.log(`  reason: ${outcome.reason}`);
  }
  const collecting = ctx.notifier as unknown as { recorded?: unknown[] };
  console.log(`notifier recorded: ${collecting.recorded?.length ?? 0} events`);
  const afterDecisions = await ctx.repos.decisions.recent(3);
  console.log(`decision log entries: ${afterDecisions.length}`);
}

main().catch((e: unknown) => {
  console.error("fatal:", e);
  process.exit(1);
});
