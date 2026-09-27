// Shared shapes. Verified against reference.md §6 + CLAUDE.md persistent-files table.
// Fields are intentionally permissive/optional — the UI must tolerate partial data.

// ── Live: getMyPositions() ──────────────────────────────────────────
export interface Position {
  position: string;
  pool: string;
  pair?: string;
  pool_name?: string;
  base_mint?: string;
  strategy?: string;
  lower_bin?: number | null;
  upper_bin?: number | null;
  active_bin?: number | null;
  in_range?: boolean;
  unclaimed_fees_usd?: number;
  total_value_usd?: number;
  total_value_true_usd?: number;
  collected_fees_usd?: number;
  pnl_usd?: number;
  pnl_true_usd?: number;
  pnl_pct?: number;
  pnl_pct_derived?: number;
  pnl_pct_diff?: number;
  pnl_pct_suspicious?: boolean;
  peak_pnl_pct?: number | null;
  fee_per_tvl_24h?: number | null;
  age_minutes?: number | null;
  minutes_out_of_range?: number;
  instruction?: string | null;
  // ── merged from TrackedPosition by the bridge (may be absent if untracked) ──
  deployed_at?: string | null;
  amount_sol_initial?: number | null;
  initial_value_usd?: number | null;
  entry_mcap?: number | null;
  current_mcap?: number | null;
  holders_at_entry?: number | null;
  smart_wallets_present?: boolean | null;
  bin_step?: number | null;
  volatility?: number | null;
  fee_tvl_ratio?: number | null;
  organic_score?: number | null;
  active_bin_at_deploy?: number | null;
  /** "deploy" = tracked from Meridian's own deploy_position hook (full context).
   *  "external" = reconciled from chain (Meteora UI / pre-hook / another wallet path)
   *  — deploy-hook-only fields (volatility, fee_tvl_ratio, smart_wallets_present)
   *  cannot be recovered and should render "external" instead of "-". */
  source?: "deploy" | "external";
}

export interface PositionsResponse {
  wallet?: string | null;
  total_positions?: number;
  positions: Position[];
  error?: string;
}

// ── Live: getStateSummary() + wallet balance ────────────────────────
export interface StateSummaryPosition {
  position: string;
  pool: string;
  strategy?: string;
  deployed_at?: string;
  out_of_range_since?: string | null;
  minutes_out_of_range?: number;
  total_fees_claimed_usd?: number;
  initial_fee_tvl_24h?: number;
  rebalance_count?: number;
  instruction?: string | null;
}

export interface StateSummary {
  open_positions: number;
  closed_positions: number;
  total_fees_claimed_usd: number;
  positions: StateSummaryPosition[];
  last_updated?: string;
  recent_events?: Array<{ ts?: string; action?: string; position?: string; pool_name?: string; reason?: string }>;
}

export interface WalletBalance {
  wallet?: string;
  sol?: number;
  sol_price?: number;
  sol_usd?: number;
  usdc?: number;
  tokens?: Array<{ mint: string; symbol: string; balance: number; usd: number | null }>;
  total_usd?: number;
  error?: string;
}

export interface SummaryResponse {
  summary: StateSummary | null;
  balance: WalletBalance | null;
}

// ── Static file: lessons.json ───────────────────────────────────────
export interface Lesson {
  id: number;
  rule: string;
  tags?: string[];
  outcome?: string;
  sourceType?: string;
  confidence?: number;
  role?: string;
  pinned?: boolean;
  context?: string;
  createdAt?: string;
}

export interface PerformanceEntry {
  position?: string;
  pool?: string;
  pool_name?: string;
  base_mint?: string;
  strategy?: string;
  bin_range?: { min?: number; max?: number; bins_below?: number; bins_above?: number };
  bin_step?: number;
  volatility?: number;
  fee_tvl_ratio?: number;
  organic_score?: number;
  amount_sol?: number;
  initial_value_usd?: number;
  final_value_usd?: number;
  minutes_in_range?: number;
  entry_mcap?: number;
  exit_mcap?: number;
  entry_tvl?: number;
  exit_tvl?: number;
  pnl_pct?: number;
  pnl_usd?: number;
  fees_earned_usd?: number;
  /** `meteora_closed` = Meteora's settled totals; `estimate` / absent = close-time snapshot. */
  pnl_source?: "estimate" | "meteora_closed";
  range_efficiency?: number;
  minutes_held?: number;
  close_reason?: string;
  closed_at?: string;
  recorded_at?: string;
  ts?: string;
  signal_snapshot?: Record<string, unknown>;
}

export interface LessonsFile {
  lessons?: Lesson[];
  performance?: PerformanceEntry[];
}

// ── Static file: decision-log.json ──────────────────────────────────
export type DecisionType = "deploy" | "close" | "skip" | "no_deploy";

export interface RejectedCandidate {
  pool?: string;
  pool_name?: string;
  name?: string;
  reason?: string;
  [k: string]: unknown;
}

export interface Decision {
  id?: string | number;
  ts?: string | number;
  type?: DecisionType | string;
  actor?: string;
  pool?: string;
  pool_name?: string;
  position?: string;
  summary?: string;
  reason?: string;
  risks?: string[];
  metrics?: Record<string, unknown>;
  rejected?: (RejectedCandidate | string)[];
}

export interface DecisionLogFile {
  decisions?: Decision[];
}

// ── Static file: strategy-library.json ──────────────────────────────
export interface Strategy {
  id: string;
  name: string;
  author?: string;
  lp_strategy?: string;
  token_criteria?: Record<string, unknown>;
  entry?: Record<string, unknown> | string;
  range?: Record<string, unknown> | string;
  exit?: Record<string, unknown> | string;
  best_for?: string;
  raw?: string;
}

export interface StrategyLibraryFile {
  active?: string;
  strategies?: Record<string, Strategy>;
}

// ── Static file: smart-wallets.json ─────────────────────────────────
export interface SmartWallet {
  name: string;
  address: string;
  category?: string;
  type?: "lp" | "holder";
  addedAt?: string;
}

export interface SmartWalletsFile {
  wallets?: SmartWallet[];
}

// ── Static file: follow-state.json ──────────────────────────────────
export interface FollowedWallet {
  address: string;
  label?: string;
  enabled?: boolean;
  addedAt?: string;
  /** Fraction of free SOL per mirror, overriding follow.positionSizePct. Null = use the global value. */
  sizePctOverride?: number | null;
  notes?: string | null;
}

export interface MirroredPosition {
  position: string;
  pool: string;
  pool_name?: string | null;
  base_mint?: string | null;
  source_wallet: string;
  source_label?: string;
  source_position?: string | null;
  opened_at: string;
  closed_at?: string | null;
  close_reason?: string | null;
  amount_sol?: number | null;
  lower_bin?: number | null;
  upper_bin?: number | null;
  source_lower_bin?: number | null;
  source_upper_bin?: number | null;
  source_pnl_pct?: number | null;
  lesson_id?: string | null;
}

export interface FollowStateFile {
  wallets?: FollowedWallet[];
  mirrored?: MirroredPosition[];
}

// ── Static file: signal-weights.json ────────────────────────────────
export interface SignalWeightsFile {
  weights?: Record<string, number>;
  last_recalc?: string;
  recalc_count?: number;
  history?: Array<Record<string, unknown>>;
}

// ── Static file: pool-memory.json ───────────────────────────────────
export interface PoolMemoryEntry {
  name?: string;
  base_mint?: string;
  total_deploys?: number;
  avg_pnl_pct?: number;
  win_rate?: number;
  adjusted_win_rate?: number;
  cooldown_until?: number | null;
  base_mint_cooldown_until?: number | null;
  notes?: string[];
  snapshots?: Array<Record<string, unknown>>;
  deploys?: Array<Record<string, unknown>>;
}

export type PoolMemoryFile = Record<string, PoolMemoryEntry>;

// ── Static files: blacklists ────────────────────────────────────────
export type TokenBlacklistFile = Record<string, { symbol?: string; reason?: string; added_at?: string; added_by?: string }>;
export type DevBlocklistFile = Record<string, { label?: string; reason?: string; added_at?: string }>;

// ── Read tool: get_top_candidates ───────────────────────────────────
export interface Candidate {
  pool: string;
  name?: string;
  base?: { symbol?: string; mint?: string; organic?: number; warnings?: number };
  quote?: { symbol?: string; mint?: string };
  pool_type?: string;
  bin_step?: number | null;
  fee_pct?: number;
  tvl?: number | null;
  active_tvl?: number | null;
  fee_active_tvl_ratio?: number | null;
  volatility?: number | null;
  holders?: number;
  mcap?: number | null;
  organic_score?: number;
  launchpad?: string | null;
  score?: number;
  degen_score?: number;
}

export interface TopCandidatesResult {
  candidates?: Candidate[];
  total_screened?: number;
  filtered_examples?: Array<{ name?: string; reason?: string }>;
  error?: string;
}

// ── Read tool: check_smart_wallets_on_pool ──────────────────────────
export interface SmartWalletCheck {
  pool_address?: string;
  tracked_wallets?: number;
  in_pool?: Array<{ name?: string; address?: string; category?: string }>;
  signal?: string;
  error?: string;
  [k: string]: unknown;
}

// ── Tool call result (F6) ───────────────────────────────────────────
export interface ToolResult {
  success?: boolean;
  error?: string;
  blocked?: boolean;
  reason?: string;
  applied?: Record<string, unknown>; // update_config returns { key: normalizedValue }
  unknown?: string[];
  auto_swapped?: boolean;
  sol_received?: number;
  [k: string]: unknown;
}

export interface ToolResponse {
  ok: boolean;
  result: ToolResult;
}
