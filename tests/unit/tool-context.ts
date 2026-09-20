import type { AppContext } from "../../src/app/tools/context.js";
import type { AppConfig } from "../../src/domain/schemas/config.js";
import type { PoolMemoryRepo } from "../../src/ports/pool-memory-repo.js";
import type { PositionRepo } from "../../src/ports/position-repo.js";
import type { LessonRepo } from "../../src/ports/lesson-repo.js";
import type { DecisionLogRepo } from "../../src/ports/decision-log.js";
import type { StrategyRepo } from "../../src/ports/strategy-repo.js";
import type { SmartWalletRepo } from "../../src/ports/smart-wallet-repo.js";
import type { TokenBlacklistRepo } from "../../src/ports/token-blacklist-repo.js";
import type { ChainClient } from "../../src/ports/chain-client.js";
import type { SwapClient } from "../../src/ports/swap-client.js";
import type { PoolMemoryEntry } from "../../src/domain/schemas/pool-memory.js";
import type { Lesson, PerformanceRecord } from "../../src/domain/schemas/lesson.js";
import type { DecisionEntry } from "../../src/domain/schemas/decision.js";
import { fixedClock } from "../../src/ports/clock.js";
import { nullLogger } from "../../src/ports/logger.js";
import { defaultStrategyLibrary } from "../../src/domain/schemas/strategy.js";
import { createDryRunChainClient } from "../../src/adapters/chain/dry-run.js";
import { createCollectingNotifier } from "../../src/adapters/notify/collecting-notifier.js";
import { createFakePoolDiscovery } from "../../src/adapters/market/fake-pool-discovery.js";
import { createFakeTokenInfo } from "../../src/adapters/market/fake-token-info.js";
import { createFakeRugCheck } from "../../src/adapters/market/fake-rug-check.js";
import { createFakeSmartWalletChecker } from "../../src/adapters/market/fake-smart-wallet-checker.js";
import { createFakeStudy } from "../../src/adapters/market/fake-study.js";
import { createFakeKlineClient } from "../../src/adapters/market/fake-kline.js";
import { mgmt, screening } from "./fixtures.js";

const cfg = {
  risk: { maxPositions: 3 },
  management: mgmt,
  strategy: { strategy: "bid_ask", binsBelow: 69 },
  schedule: { managementIntervalMin: 10, screeningIntervalMin: 30, healthCheckIntervalMin: 60 },
  screening,
  follow: {
    enabled: false,
    intervalSec: 45,
    positionSizePct: 0.35,
    minDeploySol: 0.05,
    maxDeploySol: 1,
    minBinsBelow: 20,
    maxBinsBelow: 120,
    fallbackBinsBelow: 55,
    strategy: "spot",
    learnEnabled: true,
  },
} as unknown as AppConfig;

/** In-memory PoolMemoryRepo — no filesystem. */
export function memPoolMemoryRepo(seed: Record<string, PoolMemoryEntry> = {}): PoolMemoryRepo {
  const db: Record<string, PoolMemoryEntry> = { ...seed };
  return {
    async load() {
      return { ok: true, value: db };
    },
    async save(next) {
      for (const k of Object.keys(db)) delete db[k];
      Object.assign(db, next);
    },
    async get(pool) {
      return db[pool] ?? null;
    },
    async upsert(pool, entry) {
      db[pool] = entry;
    },
  };
}

export function memPositionRepo(): PositionRepo {
  return {
    async load() {
      return { ok: true, value: { positions: {}, recentEvents: [], lastUpdated: null } };
    },
    async save() {},
    async get() {
      return null;
    },
    async all() {
      return [];
    },
    async upsert() {},
    async pushEvent() {},
  };
}

export function memLessonRepo(): LessonRepo {
  const lessons: Lesson[] = [];
  const performance: PerformanceRecord[] = [];
  return {
    async load() {
      return { ok: true, value: { lessons, performance } };
    },
    async save(file) {
      lessons.length = 0;
      lessons.push(...file.lessons);
      performance.length = 0;
      performance.push(...file.performance);
    },
    async listLessons({ role, pinned, tag, limit } = {}) {
      let out = lessons;
      if (role != null) out = out.filter((l) => l.role === role || l.role == null);
      if (pinned != null) out = out.filter((l) => l.pinned === pinned);
      if (tag != null) out = out.filter((l) => l.tags?.includes(tag));
      return limit != null ? out.slice(-limit) : out;
    },
    async addLesson(l) {
      lessons.push(l);
    },
    async pinLesson(id) {
      const l = lessons.find((x) => x.id === id);
      if (!l) return false;
      l.pinned = true;
      return true;
    },
    async unpinLesson(id) {
      const l = lessons.find((x) => x.id === id);
      if (!l) return false;
      l.pinned = false;
      return true;
    },
    async appendPerformance(p) {
      performance.push(p);
    },
    async recentPerformance(limit = 50) {
      return performance.slice(-limit);
    },
  };
}

export function memDecisionLog(): DecisionLogRepo {
  const decisions: DecisionEntry[] = [];
  return {
    async load() {
      return { ok: true, value: { decisions } };
    },
    async append(entry) {
      decisions.unshift(entry);
      if (decisions.length > 100) decisions.length = 100;
    },
    async recent(limit = 10) {
      return decisions.slice(0, limit);
    },
  };
}

export function memStrategyRepo(): StrategyRepo {
  let lib = defaultStrategyLibrary();
  return {
    async load() {
      return { ok: true, value: lib };
    },
    async save(next) {
      lib = next;
    },
    async getActive() {
      return lib.strategies[lib.active] ?? null;
    },
    async setActive(id) {
      if (!lib.strategies[id]) return false;
      lib.active = id;
      return true;
    },
    async list() {
      return Object.values(lib.strategies);
    },
    async upsert(entry) {
      lib.strategies[entry.id] = entry;
    },
    async remove(id) {
      if (!lib.strategies[id]) return false;
      delete lib.strategies[id];
      return true;
    },
  };
}

export function memSmartWalletRepo(): SmartWalletRepo {
  const wallets: import("../../src/domain/schemas/smart-wallet.js").SmartWallet[] = [];
  return {
    async load() {
      return { ok: true, value: { wallets } };
    },
    async list() {
      return wallets;
    },
    async add(w) {
      const idx = wallets.findIndex((x) => x.address === w.address);
      if (idx === -1) wallets.push(w);
      else wallets[idx] = w;
    },
    async remove(addr) {
      const before = wallets.length;
      const kept = wallets.filter((w) => w.address !== addr);
      wallets.length = 0;
      wallets.push(...kept);
      return kept.length !== before;
    },
  };
}

export function memDevBlocklistRepo(): import("../../src/ports/dev-blocklist-repo.js").DevBlocklistRepo {
  const bl: Record<string, import("../../src/domain/schemas/dev-blocklist.js").DevBlocklistEntry> = {};
  return {
    async load() {
      return { ok: true, value: bl };
    },
    async isBlocked(wallet) {
      return Object.prototype.hasOwnProperty.call(bl, wallet);
    },
    async add(wallet, entry) {
      bl[wallet] = entry;
    },
    async remove(wallet) {
      if (!Object.prototype.hasOwnProperty.call(bl, wallet)) return false;
      delete bl[wallet];
      return true;
    },
    async list() {
      return Object.entries(bl).map(([wallet, entry]) => ({ wallet, entry }));
    },
  };
}

export function memFollowRepo(
  seed: Partial<import("../../src/domain/schemas/follow-wallet.js").FollowStateFile> = {},
): import("../../src/ports/follow-repo.js").FollowRepo {
  type FW = import("../../src/domain/schemas/follow-wallet.js").FollowedWallet;
  type MP = import("../../src/domain/schemas/follow-wallet.js").MirroredPosition;
  const wallets: FW[] = [...(seed.wallets ?? [])];
  const seen: Record<string, string[]> = { ...(seed.seen ?? {}) };
  const seeded: string[] = [...(seed.seeded ?? [])];
  const mirrored: MP[] = [...(seed.mirrored ?? [])];
  return {
    async load() {
      return { ok: true, value: { wallets, seen, seeded, mirrored } };
    },
    async listWallets() {
      return wallets;
    },
    async addWallet(w) {
      const i = wallets.findIndex((x) => x.address === w.address);
      if (i === -1) wallets.push(w);
      else wallets[i] = { ...wallets[i], ...w } as FW;
    },
    async removeWallet(addr) {
      const before = wallets.length;
      const kept = wallets.filter((w) => w.address !== addr);
      wallets.length = 0;
      wallets.push(...kept);
      if (kept.length === before) return false;
      delete seen[addr];
      const s2 = seeded.filter((a) => a !== addr);
      seeded.length = 0;
      seeded.push(...s2);
      return true;
    },
    async setWalletEnabled(addr, enabled) {
      const w = wallets.find((x) => x.address === addr);
      if (!w) return false;
      w.enabled = enabled;
      if (enabled) {
        delete seen[addr];
        const s2 = seeded.filter((a) => a !== addr);
        seeded.length = 0;
        seeded.push(...s2);
      }
      return true;
    },
    async getSeen(addr) {
      return seeded.includes(addr) ? seen[addr] ?? [] : null;
    },
    async setSeen(addr, pools) {
      seen[addr] = pools;
      if (!seeded.includes(addr)) seeded.push(addr);
    },
    async listMirrored() {
      return mirrored;
    },
    async listOpenMirrored() {
      return mirrored.filter((m) => m.closed_at == null);
    },
    async addMirrored(rec) {
      const i = mirrored.findIndex((m) => m.position === rec.position);
      if (i === -1) mirrored.push(rec);
      else mirrored[i] = { ...mirrored[i], ...rec } as MP;
    },
    async updateMirrored(position, patch) {
      const i = mirrored.findIndex((m) => m.position === position);
      if (i === -1) return false;
      mirrored[i] = { ...mirrored[i], ...patch } as MP;
      return true;
    },
  };
}

export function memTokenBlacklistRepo(): TokenBlacklistRepo {
  const bl: Record<string, import("../../src/domain/schemas/blacklist.js").BlacklistEntry> = {};
  return {
    async load() {
      return { ok: true, value: bl };
    },
    async isBlacklisted(mint) {
      return Object.prototype.hasOwnProperty.call(bl, mint);
    },
    async add(mint, entry) {
      bl[mint] = entry;
    },
    async remove(mint) {
      if (!Object.prototype.hasOwnProperty.call(bl, mint)) return false;
      delete bl[mint];
      return true;
    },
    async list() {
      return Object.entries(bl).map(([mint, entry]) => ({ mint, entry }));
    },
  };
}

export function memSwapClient(): SwapClient {
  return {
    async swap(args) {
      return {
        success: true,
        input_mint: args.input_mint,
        output_mint: args.output_mint,
        amount_in: args.amount_in,
        amount_out: args.amount_in,
        tx: `mem-swap-tx`,
        dry_run: true,
      };
    },
  };
}

export interface CtxOverrides {
  clock?: AppContext["clock"];
  logger?: AppContext["logger"];
  config?: AppConfig;
  configPath?: string;
  chain?: ChainClient;
  swap?: SwapClient;
  notifier?: AppContext["notifier"];
  market?: Partial<AppContext["market"]>;
  repos?: Partial<AppContext["repos"]>;
}

export function makeCtx(over: CtxOverrides = {}): AppContext {
  const clock = over.clock ?? fixedClock("2026-07-05T12:00:00.000Z");
  const logger = over.logger ?? nullLogger;
  const chain = over.chain ?? createDryRunChainClient({ clock });
  const swap = over.swap ?? memSwapClient();
  const notifier = over.notifier ?? createCollectingNotifier();
  const repos: AppContext["repos"] = {
    positions: over.repos?.positions ?? memPositionRepo(),
    poolMemory: over.repos?.poolMemory ?? memPoolMemoryRepo(),
    lessons: over.repos?.lessons ?? memLessonRepo(),
    decisions: over.repos?.decisions ?? memDecisionLog(),
    strategies: over.repos?.strategies ?? memStrategyRepo(),
    smartWallets: over.repos?.smartWallets ?? memSmartWalletRepo(),
    tokenBlacklist: over.repos?.tokenBlacklist ?? memTokenBlacklistRepo(),
    devBlocklist: over.repos?.devBlocklist ?? memDevBlocklistRepo(),
    follow: over.repos?.follow ?? memFollowRepo(),
  };
  const market: AppContext["market"] = {
    pools: over.market?.pools ?? createFakePoolDiscovery({ seed: [] }),
    tokenInfo: over.market?.tokenInfo ?? createFakeTokenInfo(),
    rugCheck: over.market?.rugCheck ?? createFakeRugCheck(),
    smartWalletChecker: over.market?.smartWalletChecker ?? createFakeSmartWalletChecker(),
    study: over.market?.study ?? createFakeStudy(),
    kline: over.market?.kline ?? createFakeKlineClient(),
  };
  return {
    clock,
    logger,
    config: over.config ?? cfg,
    configPath: over.configPath ?? "/tmp/meridian-test-user-config.json",
    chain,
    swap,
    notifier,
    market,
    repos,
  };
}
