"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "./api";
import { LIVE_INTERVAL, FILE_INTERVAL } from "./query";
import type { CommunityLessonsResponse, PositionsResponse, SummaryResponse } from "./types";

// Query keys are the invalidation contract used by useToolMutation (M2).
// Live keys: "positions", "summary". File keys: the file name (e.g. "lessons").

export function usePositions() {
  return useQuery({
    queryKey: ["positions"],
    queryFn: () => fetchJson<PositionsResponse>("/api/state/positions"),
    refetchInterval: LIVE_INTERVAL,
  });
}

export function useSummary() {
  return useQuery({
    queryKey: ["summary"],
    queryFn: () => fetchJson<SummaryResponse>("/api/state/summary"),
    refetchInterval: LIVE_INTERVAL,
  });
}

/** Community backup lessons + the verdict the screener applies (judged by the daemon). */
export function useCommunityLessons() {
  return useQuery({
    queryKey: ["community-lessons"],
    queryFn: () => fetchJson<CommunityLessonsResponse>("/api/state/community-lessons"),
    refetchInterval: FILE_INTERVAL,
  });
}

export function useFile<T = unknown>(name: string) {
  return useQuery({
    queryKey: [name],
    queryFn: () => fetchJson<T>(`/api/files/${name}`),
    refetchInterval: FILE_INTERVAL,
  });
}
