"use client";

import { useMemo, useState } from "react";
import { Rocket, XCircle, SkipForward, ProhibitInset, CaretRight } from "@phosphor-icons/react";
import type { Icon } from "@/lib/icon";
import { Badge } from "./ui/Badge";
import { relativeTime, absoluteTime } from "@/lib/format";
import type { Decision } from "@/lib/types";
import { cn } from "@/lib/cn";

const TYPE_META: Record<string, { icon: Icon; tone: "profit" | "loss" | "neutral" | "warning" | "accent"; label: string }> = {
  deploy: { icon: Rocket, tone: "profit", label: "Deploy" },
  close: { icon: XCircle, tone: "loss", label: "Close" },
  skip: { icon: SkipForward, tone: "neutral", label: "Skip" },
  no_deploy: { icon: ProhibitInset, tone: "warning", label: "No deploy" },
};

function DecisionRow({ d }: { d: Decision }) {
  const [open, setOpen] = useState(false);
  const meta = TYPE_META[d.type ?? ""] ?? { icon: CaretRight, tone: "neutral" as const, label: d.type ?? "event" };
  const IconEl = meta.icon;
  const hasDetail = !!(d.reason || d.risks?.length || (d.metrics && Object.keys(d.metrics).length) || d.rejected?.length);

  return (
    <li className="relative pl-8">
      <span className="absolute left-2 top-1.5" style={{ color: `var(--${meta.tone === "neutral" ? "text-tertiary" : meta.tone})` }}>
        <IconEl size={16} weight="bold" />
      </span>
      <div className="border-b border-border pb-3">
        <button
          onClick={() => hasDetail && setOpen((o) => !o)}
          className={cn("flex w-full items-start justify-between gap-3 text-left", hasDetail && "cursor-pointer")}
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={meta.tone}>{meta.label}</Badge>
              {d.actor && <span className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">{d.actor}</span>}
              {d.pool_name && <span className="text-[12px] font-semibold text-text-primary">{d.pool_name}</span>}
              {d.pool && <span className="font-mono text-[12px] text-text-tertiary">{d.pool_name ? `${d.pool.slice(0, 6)}…` : d.pool}</span>}
            </div>
            <p className="mt-1 text-[13px] text-text-secondary">{d.summary || d.reason || "-"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="whitespace-nowrap text-[11px] text-text-tertiary" title={absoluteTime(d.ts)}>
              {relativeTime(d.ts)}
            </span>
            {hasDetail && <CaretRight size={14} className={cn("text-text-tertiary transition-transform", open && "rotate-90")} />}
          </div>
        </button>

        {open && hasDetail && (
          <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-md)] border border-border bg-surface-2 p-3 text-[12px]">
            {d.reason && (
              <div>
                <span className="text-text-tertiary">Reason: </span>
                <span className="text-text-secondary">{d.reason}</span>
              </div>
            )}
            {d.risks?.length ? (
              <div>
                <span className="text-text-tertiary">Risks: </span>
                <span className="text-text-secondary">{d.risks.join(", ")}</span>
              </div>
            ) : null}
            {d.metrics && Object.keys(d.metrics).length ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono tnum">
                {Object.entries(d.metrics).map(([k, v]) => (
                  <span key={k} className="text-text-secondary">
                    <span className="text-text-tertiary">{k}:</span> {String(v)}
                  </span>
                ))}
              </div>
            ) : null}
            {d.rejected?.length ? (
              <div>
                <div className="mb-1 text-text-tertiary">Rejected candidates ({d.rejected.length}):</div>
                <ul className="flex flex-col gap-1">
                  {d.rejected.map((r, i) => {
                    let name: string;
                    let reason: string;
                    if (typeof r === "string") {
                      const sep = r.indexOf(" — ");
                      if (sep >= 0) {
                        name = r.slice(0, sep).trim();
                        reason = r.slice(sep + 3).trim();
                      } else {
                        name = "candidate";
                        reason = r;
                      }
                    } else {
                      name = r.pool_name || r.name || r.pool || "candidate";
                      reason = r.reason || "-";
                    }
                    return (
                      <li key={i} className="flex flex-wrap gap-2">
                        <span className="font-mono text-text-secondary">{name}</span>
                        <span className="text-text-tertiary">—</span>
                        <span className="text-text-tertiary">{reason || "-"}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </li>
  );
}

// The log is uncapped, so render in pages — thousands of rows at once would stall the tab.
const PAGE = 100;

function matchesQuery(d: Decision, q: string): boolean {
  if (!q) return true;
  const hay = [d.pool_name, d.pool, d.position, d.summary, d.reason, d.actor]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

export function DecisionTimeline({ decisions, showFilters = true }: { decisions: Decision[]; showFilters?: boolean }) {
  const [type, setType] = useState<string>("all");
  const [actor, setActor] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const actors = useMemo(() => Array.from(new Set(decisions.map((d) => d.actor).filter(Boolean))) as string[], [decisions]);

  const filtered = useMemo(
    () =>
      decisions.filter(
        (d) => (type === "all" || d.type === type) && (actor === "all" || d.actor === actor) && matchesQuery(d, query.trim())
      ),
    [decisions, type, actor, query]
  );
  const visible = showFilters ? filtered.slice(0, shown) : filtered;

  const selectCls =
    "h-8 rounded-[var(--radius-md)] border border-border-strong bg-surface-2 px-2 text-[13px] text-text-primary";

  return (
    <div className="flex flex-col gap-4">
      {showFilters && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            className={cn(selectCls, "w-full min-w-0 sm:w-64")}
            placeholder="Search coin, pool, position, reason…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
            aria-label="Search decisions"
          />
          <select className={selectCls} value={type} onChange={(e) => { setType(e.target.value); setShown(PAGE); }} aria-label="Filter by type">
            <option value="all">All types</option>
            <option value="deploy">Deploy</option>
            <option value="close">Close</option>
            <option value="skip">Skip</option>
            <option value="no_deploy">No deploy</option>
          </select>
          <select className={selectCls} value={actor} onChange={(e) => { setActor(e.target.value); setShown(PAGE); }} aria-label="Filter by actor">
            <option value="all">All actors</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <span className="text-[12px] text-text-tertiary">
            {visible.length} of {filtered.length}
            {filtered.length !== decisions.length ? ` (${decisions.length} total)` : ""}
          </span>
        </div>
      )}
      <ul className="flex flex-col gap-3">
        {visible.map((d, i) => (
          <DecisionRow key={d.id ?? i} d={d} />
        ))}
      </ul>
      {showFilters && visible.length < filtered.length && (
        <button
          onClick={() => setShown((n) => n + PAGE)}
          className="self-center rounded-[var(--radius-md)] border border-border-strong bg-surface-2 px-4 py-1.5 text-[13px] text-text-secondary hover:text-text-primary"
        >
          Load {Math.min(PAGE, filtered.length - visible.length)} more
        </button>
      )}
    </div>
  );
}
