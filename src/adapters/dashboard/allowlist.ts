// Tool + file allowlists for the dashboard bridge.
// Names verified against the tool registry (src/app/tools/impls). self_update and
// anything outside these sets is denied by default (PRD §8.8, reference.md §3).
// Ported from dashboard/bridge/allowlist.js.

export const READ_TOOLS = new Set<string>([
  "get_my_positions", "get_position_pnl", "get_wallet_balance", "get_wallet_positions",
  "get_top_candidates", "get_pool_detail", "get_pool_kline", "get_active_bin", "get_pool_memory",
  "get_recent_decisions", "get_performance_history", "list_lessons", "list_strategies",
  "list_smart_wallets", "list_blacklist", "list_blocked_deployers", "check_smart_wallets_on_pool",
  "list_follow_wallets",
]);

// Read-only surface for the dashboard chat (M5, Fase A). Passed to runAgentLoop as
// `toolFilter` so the LLM literally cannot pick a write tool. Superset of READ_TOOLS
// plus the GENERAL read/enrichment tools. MUST NOT contain any write tool.
export const CHAT_READ_TOOLS: readonly string[] = [
  ...READ_TOOLS,
  "get_recent_decisions", "get_performance_history", "list_lessons", "list_strategies",
  "list_smart_wallets", "list_blacklist", "list_blocked_deployers",
  "get_pool_memory", "get_pool_detail", "get_pool_kline", "search_pools", "discover_pools",
  "get_token_info", "get_token_holders", "get_token_narrative",
  "study_top_lpers", "get_top_lpers",
];

export const WRITE_TOOLS_DASHBOARD = new Set<string>([
  "deploy_position", "close_position", "claim_fees", "swap_token", "set_position_note",
  "add_lesson", "pin_lesson", "unpin_lesson", "clear_lessons", "add_strategy", "remove_strategy",
  "set_active_strategy", "update_config", "add_to_blacklist", "remove_from_blacklist",
  "add_smart_wallet", "remove_smart_wallet", "block_deployer", "unblock_deployer",
  // Follow-the-wallet management. `follow_deploy_position` is deliberately ABSENT:
  // the mirror write is reachable only from the follow cycle, never from the bridge.
  "add_follow_wallet", "remove_follow_wallet", "set_follow_wallet_enabled",
]);

// :name → file at the state dir (GET /state/file/:name). user-config is redacted before send.
export const FILE_WHITELIST: Record<string, string> = {
  "lessons": "lessons.json",
  "decision-log": "decision-log.json",
  "pool-memory": "pool-memory.json",
  "signal-weights": "signal-weights.json",
  "strategy-library": "strategy-library.json",
  "smart-wallets": "smart-wallets.json",
  "token-blacklist": "token-blacklist.json",
  "dev-blocklist": "dev-blocklist.json",
  "state": "state.json",
  "follow-state": "follow-state.json",
  "user-config": "user-config.json",
};

export const isReadTool = (n: string): boolean => READ_TOOLS.has(n);
export const isWriteTool = (n: string): boolean => WRITE_TOOLS_DASHBOARD.has(n);
export const isAllowedTool = (n: string): boolean => isReadTool(n) || isWriteTool(n); // self_update & others → false
export const resolveFile = (name: string): string | null =>
  Object.prototype.hasOwnProperty.call(FILE_WHITELIST, name) ? FILE_WHITELIST[name] ?? null : null;
