"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, Warning, Info } from "@phosphor-icons/react";
import { useFile } from "@/lib/hooks";
import { Button } from "./ui/Button";
import { ConfirmModal } from "./ConfirmModal";
import { SkeletonRows, ErrorState } from "./states";
import { useDaemonStatus } from "./DaemonStatus";
import {
  CONFIG_FIELDS,
  CONFIG_GROUPS,
  GROUP_LABELS,
  GROUP_HELP,
  type ConfigField,
  type ConfigGroup,
} from "@/lib/config-map";
import type { ToolResult } from "@/lib/types";

type Val = string | boolean;
type Cfg = Record<string, unknown>;

function readValue(cfg: Cfg, key: string): unknown {
  const v = cfg[key];
  return v;
}

function toInput(field: ConfigField, raw: unknown): Val {
  if (field.type === "boolean") return raw === true;
  if (field.type === "array") return Array.isArray(raw) ? raw.join(", ") : raw == null ? "" : String(raw);
  return raw == null ? "" : String(raw);
}

function coerce(field: ConfigField, v: Val): unknown {
  if (field.type === "boolean") return v === true;
  if (field.type === "number") return Number(v);
  if (field.type === "array")
    return String(v)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return String(v);
}

const inputCls =
  "h-9 w-full rounded-[var(--radius-md)] border border-border-strong bg-surface-2 px-3 text-[13px] text-text-primary font-mono";

const tabCls =
  "px-3 py-1.5 text-[13px] rounded-[var(--radius-md)] transition-colors";
const tabActiveCls = "bg-surface-3 text-text-primary";
const tabIdleCls = "text-text-secondary hover:text-text-primary hover:bg-surface-2";

export function ConfigForm() {
  const q = useFile<Cfg>("user-config");
  const { online } = useDaemonStatus();
  const initialized = useRef(false);
  const [values, setValues] = useState<Record<string, Val>>({});
  const [initial, setInitial] = useState<Record<string, Val>>({});
  const [activeGroup, setActiveGroup] = useState<ConfigGroup>(CONFIG_GROUPS[0]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<{ applied: string[]; unknown: string[] } | null>(null);

  // Initialize once from the first config payload; don't clobber edits on refetch.
  useEffect(() => {
    if (initialized.current || !q.data) return;
    const next: Record<string, Val> = {};
    for (const field of CONFIG_FIELDS) {
      next[field.key] = toInput(field, readValue(q.data as Cfg, field.key));
    }
    setValues(next);
    setInitial(next);
    initialized.current = true;
  }, [q.data]);

  const set = (key: string, v: Val) => setValues((prev) => ({ ...prev, [key]: v }));

  // A change is submittable unless it's a number field cleared to empty / non-finite.
  const submittable = (field: ConfigField, v: Val): boolean => {
    if (field.type !== "number") return true;
    const s = String(v).trim();
    return s !== "" && Number.isFinite(Number(s));
  };

  const dirtyKeys = useMemo(
    () =>
      CONFIG_FIELDS.filter((f) => values[f.key] !== initial[f.key] && submittable(f, values[f.key])).map((f) => f.key),
    [values, initial]
  );

  // Per-group dirty count for tab badges.
  const dirtyPerGroup = useMemo(() => {
    const out: Record<ConfigGroup, number> = {
      screening: 0, deploy: 0, exit: 0, rebalance: 0, automation: 0, follow: 0, integrations: 0,
    };
    for (const key of dirtyKeys) {
      const field = CONFIG_FIELDS.find((f) => f.key === key);
      if (field) out[field.group]++;
    }
    return out;
  }, [dirtyKeys]);

  const changes = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const key of dirtyKeys) {
      const field = CONFIG_FIELDS.find((f) => f.key === key)!;
      out[key] = coerce(field, values[key]);
    }
    return out;
  }, [dirtyKeys, values]);

  if (q.isLoading && !initialized.current) return <SkeletonRows rows={10} />;
  if (q.isError && !initialized.current) return <ErrorState message="Failed to load config." onRetry={() => q.refetch()} />;

  const activeFields = CONFIG_FIELDS.filter((f) => f.group === activeGroup);

  return (
    <div className="flex flex-col gap-4">
      {lastResult && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-border bg-surface-1 p-4">
          <div className="flex items-center gap-2 text-[13px] text-profit">
            <CheckCircle size={16} weight="fill" /> Applied {lastResult.applied.length} key(s)
          </div>
          {lastResult.applied.length > 0 && (
            <div className="font-mono text-[12px] text-text-secondary">{lastResult.applied.join(", ")}</div>
          )}
          {lastResult.unknown.length > 0 && (
            <div className="flex items-start gap-2 text-[12px] text-warning">
              <Warning size={14} className="mt-0.5" /> Unknown (skipped): {lastResult.unknown.join(", ")}
            </div>
          )}
        </div>
      )}

      {/* Tab strip */}
      <div className="flex flex-wrap items-center gap-1 rounded-[var(--radius-lg)] border border-border bg-surface-1 p-1">
        {CONFIG_GROUPS.map((g) => {
          const active = g === activeGroup;
          const dirty = dirtyPerGroup[g];
          return (
            <button
              key={g}
              type="button"
              onClick={() => setActiveGroup(g)}
              className={`${tabCls} ${active ? tabActiveCls : tabIdleCls}`}
            >
              {GROUP_LABELS[g]}
              {dirty > 0 && (
                <span
                  className="ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ backgroundColor: "var(--accent-bright)", color: "var(--surface-1)" }}
                >
                  {dirty}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Active group */}
      <section>
        <p className="mb-3 text-[12px] text-text-secondary">{GROUP_HELP[activeGroup]}</p>
        <div className="grid grid-cols-1 gap-3 rounded-[var(--radius-lg)] border border-border bg-surface-1 p-4 md:grid-cols-2 lg:grid-cols-3">
          {activeFields.map((field) => {
            const dirty = values[field.key] !== initial[field.key] && submittable(field, values[field.key]);
            return (
              <div key={field.key} className="flex flex-col gap-1">
                <label className="flex items-center gap-1 text-[12px] text-text-tertiary" htmlFor={field.key}>
                  <span className="truncate">{field.key}</span>
                  {field.unit && <span className="text-text-disabled">· {field.unit}</span>}
                  {field.help && (
                    <span className="group relative inline-flex shrink-0 cursor-help text-text-disabled hover:text-text-secondary">
                      <Info size={13} weight="bold" />
                      <span
                        role="tooltip"
                        className="pointer-events-none absolute left-1/2 top-[130%] z-30 hidden w-60 -translate-x-1/2 rounded-[var(--radius-md)] border border-border bg-surface-3 px-2.5 py-1.5 text-[11px] font-normal leading-snug text-text-secondary shadow-lg group-hover:block"
                        style={{ boxShadow: "var(--shadow-lg)" }}
                      >
                        {field.help}
                      </span>
                    </span>
                  )}
                  {field.secret && <span className="text-text-disabled">(sensitive)</span>}
                  {field.readOnly && <span className="text-text-disabled">(read-only)</span>}
                  {dirty && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "var(--accent-bright)" }} />}
                </label>
                {field.type === "boolean" ? (
                  <label className="flex h-9 items-center gap-2 text-[13px] text-text-secondary">
                    <input
                      type="checkbox"
                      checked={values[field.key] === true}
                      disabled={field.readOnly}
                      onChange={(e) => set(field.key, e.target.checked)}
                    />
                    {values[field.key] === true ? "true" : "false"}
                  </label>
                ) : field.options ? (
                  <select
                    id={field.key}
                    value={String(values[field.key] ?? "")}
                    disabled={field.readOnly}
                    onChange={(e) => set(field.key, e.target.value)}
                    className={inputCls}
                  >
                    {/* Preserve an out-of-enum current value so a stale config isn't silently rewritten. */}
                    {values[field.key] != null &&
                      String(values[field.key]) !== "" &&
                      !field.options.includes(String(values[field.key])) && (
                        <option value={String(values[field.key])}>{String(values[field.key])} (current)</option>
                      )}
                    {field.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={field.key}
                    value={String(values[field.key] ?? "")}
                    inputMode={field.type === "number" ? "decimal" : undefined}
                    placeholder={field.unit ?? undefined}
                    readOnly={field.readOnly}
                    onChange={(e) => set(field.key, e.target.value)}
                    className={inputCls}
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div
        className="sticky bottom-4 flex items-center justify-between rounded-[var(--radius-lg)] border border-border bg-surface-3 px-4 py-3 shadow-lg"
        style={{ boxShadow: "var(--shadow-lg)" }}
      >
        <span className="text-[13px] text-text-secondary">
          {dirtyKeys.length === 0 ? "No changes" : `${dirtyKeys.length} changed`}
        </span>
        <Button variant="primary" disabled={!online || dirtyKeys.length === 0} onClick={() => setConfirmOpen(true)}>
          Save changes
        </Button>
      </div>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Apply config changes?"
        toolName="update_config"
        args={{ changes, reason: "dashboard" }}
        variant="primary"
        confirmLabel="Apply"
        invalidateKeys={["user-config"]}
        confirmDisabled={dirtyKeys.length === 0}
        successMessage={`Applied ${dirtyKeys.length} config change(s).`}
        impact="Changes apply to the live config immediately. Interval keys restart the cron jobs."
        fields={[{ label: "Changed keys", value: dirtyKeys.join(", ") || "-" }]}
        onDone={(r: ToolResult) => {
          const applied = r.applied && typeof r.applied === "object" ? Object.keys(r.applied) : [];
          const unknown = Array.isArray(r.unknown) ? r.unknown : [];
          setLastResult({ applied, unknown });
          setInitial((prev) => ({ ...prev, ...values }));
        }}
      />
    </div>
  );
}
