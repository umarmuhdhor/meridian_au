"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Position, PositionsResponse } from "./types";

// SSE live updates. On `pnl_tick` we MERGE the incoming pnl fields into the
// existing enriched positions cache — a full setQueryData would overwrite the
// bridge-enriched fields (strategy, entry_mcap, bin_step, holders_at_entry,
// current_mcap, deployed_at, initial_value_usd, …) with the poller's raw
// on-chain snapshot that only carries pnl_pct + total_value_usd. Symptom:
// hard-refresh shows all fields, then blanks after ~5s on the first tick.
//
// If SSE fails, we close and rely on the existing refetchInterval to keep the
// UI live.
export function useLiveEvents(enabled = true) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/events");
      es.addEventListener("pnl_tick", (e) => {
        try {
          const incoming = JSON.parse((e as MessageEvent).data) as PositionsResponse;
          qc.setQueryData<PositionsResponse>(["positions"], (prev) => {
            if (!prev || !prev.positions) return incoming;
            const nextByAddr = new Map<string, Position>(
              (incoming.positions ?? []).map((p) => [p.position, p]),
            );
            const merged = prev.positions.map((prevPos) => {
              const upd = nextByAddr.get(prevPos.position);
              if (!upd) return prevPos;
              // Overlay ONLY the live pnl / range / value / unclaimed / active_bin
              // / in_range fields. Everything else (enriched) is preserved.
              return {
                ...prevPos,
                ...(upd.pnl_pct !== undefined ? { pnl_pct: upd.pnl_pct } : {}),
                ...(upd.pnl_pct_derived !== undefined ? { pnl_pct_derived: upd.pnl_pct_derived } : {}),
                ...(upd.pnl_pct_diff !== undefined ? { pnl_pct_diff: upd.pnl_pct_diff } : {}),
                ...(upd.pnl_pct_suspicious !== undefined ? { pnl_pct_suspicious: upd.pnl_pct_suspicious } : {}),
                ...(upd.pnl_usd !== undefined ? { pnl_usd: upd.pnl_usd } : {}),
                ...(upd.pnl_true_usd !== undefined ? { pnl_true_usd: upd.pnl_true_usd } : {}),
                ...(upd.total_value_usd !== undefined ? { total_value_usd: upd.total_value_usd } : {}),
                ...(upd.total_value_true_usd !== undefined ? { total_value_true_usd: upd.total_value_true_usd } : {}),
                ...(upd.unclaimed_fees_usd !== undefined ? { unclaimed_fees_usd: upd.unclaimed_fees_usd } : {}),
                ...(upd.collected_fees_usd !== undefined ? { collected_fees_usd: upd.collected_fees_usd } : {}),
                ...(upd.claimed_fees_usd !== undefined ? { claimed_fees_usd: upd.claimed_fees_usd } : {}),
                ...(upd.deposit_usd !== undefined ? { deposit_usd: upd.deposit_usd } : {}),
                ...(upd.active_bin !== undefined ? { active_bin: upd.active_bin } : {}),
                ...(upd.lower_bin !== undefined ? { lower_bin: upd.lower_bin } : {}),
                ...(upd.upper_bin !== undefined ? { upper_bin: upd.upper_bin } : {}),
                ...(upd.in_range !== undefined ? { in_range: upd.in_range } : {}),
                ...(upd.minutes_out_of_range !== undefined ? { minutes_out_of_range: upd.minutes_out_of_range } : {}),
                ...(upd.peak_pnl_pct !== undefined ? { peak_pnl_pct: upd.peak_pnl_pct } : {}),
              } as Position;
            });
            // Include any newly-opened positions the poller sees that aren't in
            // the enriched cache yet (they'll get enrichment on the next
            // /state/positions poll).
            const knownAddrs = new Set(prev.positions.map((p) => p.position));
            const additions = (incoming.positions ?? []).filter((p) => !knownAddrs.has(p.position));
            const positions = [...merged, ...additions];
            return {
              ...prev,
              ...(incoming.wallet !== undefined ? { wallet: incoming.wallet } : {}),
              ...(incoming.total_positions !== undefined
                ? { total_positions: incoming.total_positions }
                : { total_positions: positions.length }),
              positions,
            };
          });
        } catch {
          /* ignore malformed frame */
        }
      });
      es.addEventListener("decision", () => {
        qc.invalidateQueries({ queryKey: ["decision-log"] });
      });
      es.addEventListener("error", () => {
        // Stop auto-reconnect storms; polling fallback stays active for the session.
        es?.close();
      });
    } catch {
      /* EventSource unsupported / blocked → polling fallback */
    }
    return () => es?.close();
  }, [enabled, qc]);
}
