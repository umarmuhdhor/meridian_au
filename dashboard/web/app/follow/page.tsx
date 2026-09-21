"use client";

import Link from "next/link";
import { Info } from "@phosphor-icons/react";
import { useFile } from "@/lib/hooks";
import { FollowWalletList } from "@/components/FollowWalletList";

// Master switch + poll interval live on the Config page (tab "Follow wallet") —
// update_config is human-gated and shared with every other config field, so this
// page only manages the wallet list + shows current status, not the switch itself.
export default function FollowPage() {
  const cfg = useFile<Record<string, unknown>>("user-config");
  const enabled = Boolean(cfg.data?.followEnabled);
  const intervalSec = typeof cfg.data?.followIntervalSec === "number" ? cfg.data.followIntervalSec : null;

  return (
    <div className="flex flex-col gap-6">
      <div
        className="flex items-start gap-2 rounded-[var(--radius-lg)] border border-border px-4 py-3 text-[13px]"
        style={{ backgroundColor: enabled ? "var(--profit-tint)" : "var(--warning-tint)" }}
      >
        <Info size={16} className={enabled ? "text-profit mt-0.5" : "text-warning mt-0.5"} />
        <div>
          <span className={enabled ? "text-profit" : "text-warning"}>
            {enabled ? `Mirroring is ON — polling every ${intervalSec ?? "?"}s.` : "Mirroring is OFF (follow.enabled = false)."}
          </span>{" "}
          <span className="text-text-secondary">
            Wallets added below only mirror once the master switch is on too — flip it in{" "}
            <Link href="/config" className="text-accent-bright hover:underline">
              Config → Follow wallet
            </Link>
            . Turning it off closes every open mirror on the next tick.
          </span>
        </div>
      </div>

      <FollowWalletList />
    </div>
  );
}
