/**
 * Role → tool subset lists — mirrors agent.js MANAGER_TOOLS / SCREENER_TOOLS.
 * Ported names only; unported tools are still listed for parity so the JS agent can
 * still be run against these constants once the shim lands.
 */

export const MANAGER_TOOLS: readonly string[] = [
  "close_position",
  "claim_fees",
  "swap_token",
  "get_my_positions",
  "get_wallet_balance",
];

export const SCREENER_TOOLS: readonly string[] = [
  "deploy_position",
  "get_active_bin",
  "get_pool_memory",
  "get_pool_kline",
  "get_wallet_balance",
  "get_my_positions",
  "assert_pool_deployable",
  "get_top_candidates",
  "search_pools",
  "get_token_info",
  "get_token_holders",
  "get_token_narrative",
  "check_smart_wallets_on_pool",
];

export const GENERAL_TOOLS: readonly string[] = [
  "get_wallet_balance",
  "get_my_positions",
  "get_pool_memory",
  "get_pool_kline",
  "get_active_bin",
  "get_recent_decisions",
  "list_blacklist",
  "list_smart_wallets",
  "get_active_strategy",
  "add_to_blacklist",
  "claim_fees",
  // Follow-the-wallet management. The MIRROR itself (follow_deploy_position) is
  // intentionally absent from every role list — only the follow cycle may call it.
  "list_follow_wallets",
  "add_follow_wallet",
  "remove_follow_wallet",
  "set_follow_wallet_enabled",
];
