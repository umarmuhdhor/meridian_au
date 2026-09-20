import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { PositionRepo } from "../../ports/position-repo.js";
import type { PoolMemoryRepo } from "../../ports/pool-memory-repo.js";
import type { LessonRepo } from "../../ports/lesson-repo.js";
import type { DecisionLogRepo } from "../../ports/decision-log.js";
import type { StrategyRepo } from "../../ports/strategy-repo.js";
import type { SmartWalletRepo } from "../../ports/smart-wallet-repo.js";
import type { TokenBlacklistRepo } from "../../ports/token-blacklist-repo.js";
import type { DevBlocklistRepo } from "../../ports/dev-blocklist-repo.js";
import type { FollowRepo } from "../../ports/follow-repo.js";
import type { ChainClient } from "../../ports/chain-client.js";
import type { SwapClient } from "../../ports/swap-client.js";
import type { Notifier } from "../../ports/notifier.js";
import type { PoolDiscoveryClient } from "../../ports/pool-discovery.js";
import type { TokenInfoClient } from "../../ports/token-info-client.js";
import type { RugCheckClient } from "../../ports/rug-check.js";
import type { SmartWalletChecker } from "../../ports/smart-wallet-checker.js";
import type { StudyClient } from "../../ports/study-client.js";
import type { KlineClient } from "../../ports/kline-client.js";
import type { AppConfig } from "../../domain/schemas/config.js";
import type { DecisionActor } from "../../domain/schemas/decision.js";

/**
 * Everything a tool needs to execute. Assembled once at daemon boot and passed by reference
 * through the ReAct loop. Ports only — no concrete impls.
 */
export interface AppContext {
  clock: Clock;
  logger: Logger;
  config: AppConfig;
  /** Absolute path to the flat user-config.json — used by update_config to persist + reload. */
  configPath: string;
  chain: ChainClient;
  swap: SwapClient;
  notifier: Notifier;
  market: {
    pools: PoolDiscoveryClient;
    tokenInfo: TokenInfoClient;
    rugCheck: RugCheckClient;
    smartWalletChecker: SmartWalletChecker;
    study: StudyClient;
    /** OHLCV source for technicals (spike detection, support levels, trend). */
    kline: KlineClient;
  };
  repos: {
    positions: PositionRepo;
    poolMemory: PoolMemoryRepo;
    lessons: LessonRepo;
    decisions: DecisionLogRepo;
    strategies: StrategyRepo;
    smartWallets: SmartWalletRepo;
    tokenBlacklist: TokenBlacklistRepo;
    devBlocklist: DevBlocklistRepo;
    /** Followed wallets + mirror records for the follow-the-wallet feature. */
    follow: FollowRepo;
  };
  /**
   * Per-call attribution for deploy/close post-hooks. Set by the caller
   * (screening cycle for local-loop deploys, bridge /tool for Sage/human
   * deploys) via a scoped ctx clone; read by log-decision post-hooks.
   * Absent → post-hook falls back to the tool's registered default actor.
   */
  deployMeta?: {
    actor: DecisionActor;
    rationale?: string;
  };
}
