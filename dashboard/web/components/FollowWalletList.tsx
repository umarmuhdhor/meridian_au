"use client";

import { useState } from "react";
import { Plus, Trash, Power, UsersThree, ArrowsLeftRight } from "@phosphor-icons/react";
import { useFile } from "@/lib/hooks";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { ConfirmModal } from "./ConfirmModal";
import { Address } from "./Address";
import { SkeletonRows, EmptyState, ErrorState } from "./states";
import { useDaemonStatus } from "./DaemonStatus";
import { formatSol, relativeTime } from "@/lib/format";
import type { FollowStateFile, FollowedWallet } from "@/lib/types";

const inputCls =
  "h-9 w-full rounded-[var(--radius-md)] border border-border-strong bg-surface-2 px-3 text-[13px] text-text-primary font-mono";

export function FollowWalletList() {
  const q = useFile<FollowStateFile>("follow-state");
  const { online } = useDaemonStatus();
  const wallets = q.data?.wallets ?? [];
  const openMirrors = (q.data?.mirrored ?? []).filter((m) => !m.closed_at);

  const [addOpen, setAddOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [sizePct, setSizePct] = useState("");
  const [notes, setNotes] = useState("");

  const [toggleTarget, setToggleTarget] = useState<FollowedWallet | null>(null);
  const [removeTarget, setRemoveTarget] = useState<FollowedWallet | null>(null);

  const reset = () => {
    setAddress("");
    setLabel("");
    setSizePct("");
    setNotes("");
  };

  const openMirrorsFor = (addr: string) => openMirrors.filter((m) => m.source_wallet === addr).length;
  const pctValid = sizePct.trim() === "" || (Number(sizePct) > 0 && Number(sizePct) <= 100);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-text-primary">
          <UsersThree size={18} /> Followed wallets{" "}
          <span className="text-[12px] font-normal text-text-tertiary">({wallets.length})</span>
        </h2>
        <Button size="sm" variant="primary" disabled={!online} onClick={() => setAddOpen(true)}>
          <Plus size={14} /> Follow wallet
        </Button>
      </div>

      {q.isLoading ? (
        <SkeletonRows rows={3} />
      ) : q.isError ? (
        <ErrorState message="Failed to load followed wallets." onRetry={() => q.refetch()} />
      ) : wallets.length === 0 ? (
        <EmptyState
          icon={UsersThree}
          title="No followed wallets."
          hint="Mirror a wallet's DLMM entries and exits — bypasses screening, the TA gate, cooldowns and blacklists by design."
        />
      ) : (
        <ul className="divide-y divide-border rounded-[var(--radius-lg)] border border-border">
          {wallets.map((w) => {
            const n = openMirrorsFor(w.address);
            return (
              <li key={w.address} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-text-primary">{w.label || "wallet"}</span>
                    <Badge tone={w.enabled ? "profit" : "neutral"}>{w.enabled ? "enabled" : "disabled"}</Badge>
                    {n > 0 && (
                      <Badge tone="accent">
                        {n} open mirror{n === 1 ? "" : "s"}
                      </Badge>
                    )}
                  </div>
                  <Address value={w.address} />
                  <div className="mt-1 text-[12px] text-text-tertiary">
                    {w.sizePctOverride != null
                      ? `${(w.sizePctOverride * 100).toFixed(0)}% of free SOL (override)`
                      : "uses global size %"}
                    {w.notes ? ` · ${w.notes}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" disabled={!online} onClick={() => setToggleTarget(w)}>
                    <Power size={14} /> {w.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button size="sm" variant="danger-ghost" disabled={!online} onClick={() => setRemoveTarget(w)}>
                    <Trash size={14} /> Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {openMirrors.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-primary">
            <ArrowsLeftRight size={16} /> Open mirrored positions{" "}
            <span className="text-[12px] font-normal text-text-tertiary">({openMirrors.length})</span>
          </h3>
          <ul className="divide-y divide-border rounded-[var(--radius-lg)] border border-border">
            {openMirrors.map((m) => {
              const w = wallets.find((x) => x.address === m.source_wallet);
              return (
                <li key={m.position} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                  <div className="min-w-0">
                    <div className="text-text-primary">
                      {m.pool_name || "pool"}{" "}
                      <span className="text-text-tertiary">· {w?.label || m.source_label || "wallet"}</span>
                    </div>
                    <Address value={m.position} />
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-text-secondary tnum">{formatSol(m.amount_sol)}</div>
                    <div className="text-[11px] text-text-tertiary">{relativeTime(m.opened_at)}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <ConfirmModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Follow this wallet?"
        toolName="add_follow_wallet"
        args={{
          address: address.trim(),
          label: label.trim(),
          size_pct_override: sizePct.trim() === "" ? null : Number(sizePct) / 100,
          notes: notes.trim() || null,
        }}
        variant="primary"
        confirmLabel="Follow wallet"
        invalidateKeys={["follow-state"]}
        confirmDisabled={!address.trim() || !pctValid}
        successMessage="Wallet followed."
        onDone={reset}
        impact="Mirrors this wallet's DLMM entries and exits once follow.enabled is on (Config → Follow wallet tab) and this wallet is enabled. Bypasses screening, the TA gate, cooldowns and blacklists — only wallet balance and maxPositions still apply. Positions it already holds are never back-filled."
        extra={
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[12px] text-text-tertiary">Wallet address (required)</label>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className={inputCls}
                placeholder="wallet address"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[12px] text-text-tertiary">Label</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className={inputCls}
                placeholder="e.g. alpha-lp-1"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[12px] text-text-tertiary">Size % override</label>
              <input
                value={sizePct}
                onChange={(e) => setSizePct(e.target.value)}
                className={inputCls}
                placeholder="blank = use global follow.positionSizePct"
                inputMode="decimal"
              />
              {!pctValid && <p className="text-[11px] text-loss">Must be between 0 and 100.</p>}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[12px] text-text-tertiary">Notes</label>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} placeholder="optional" />
            </div>
          </div>
        }
      />

      <ConfirmModal
        open={!!toggleTarget}
        onClose={() => setToggleTarget(null)}
        title={toggleTarget?.enabled ? "Disable this wallet?" : "Enable this wallet?"}
        toolName="set_follow_wallet_enabled"
        args={{ address: toggleTarget?.address, enabled: !toggleTarget?.enabled }}
        variant={toggleTarget?.enabled ? "danger" : "primary"}
        confirmLabel={toggleTarget?.enabled ? "Disable" : "Enable"}
        invalidateKeys={["follow-state"]}
        successMessage={toggleTarget?.enabled ? "Wallet disabled." : "Wallet enabled."}
        fields={toggleTarget ? [{ label: "Wallet", value: toggleTarget.label || toggleTarget.address }] : []}
        impact={
          toggleTarget?.enabled
            ? `Disabling CLOSES any positions still mirrored from this wallet on the next follow tick (${openMirrorsFor(
                toggleTarget.address
              )} open now) — a mirror has no local exit rules, so unfollowing unwinds it rather than leaving it with none.`
            : "Re-enabling re-seeds the baseline — positions this wallet opened while it was off are never back-filled."
        }
      />

      <ConfirmModal
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        title="Stop following this wallet?"
        toolName="remove_follow_wallet"
        args={{ address: removeTarget?.address }}
        variant="danger"
        confirmLabel="Remove"
        invalidateKeys={["follow-state"]}
        successMessage="Wallet removed."
        fields={removeTarget ? [{ label: "Wallet", value: removeTarget.label || removeTarget.address }] : []}
        impact={
          removeTarget
            ? `Any positions still mirrored from this wallet are CLOSED on the next follow tick (${openMirrorsFor(
                removeTarget.address
              )} open now) — a mirror's exit belongs to the wallet it was copied from.`
            : undefined
        }
      />
    </section>
  );
}
