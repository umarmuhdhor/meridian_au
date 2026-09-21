import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { createJsonFollowRepo } from "../../src/adapters/persistence/json/follow-repo.js";
import { nullLogger } from "../../src/ports/logger.js";
import type { FollowedWallet, MirroredPosition } from "../../src/domain/schemas/follow-wallet.js";
import { mkTmpDir, rmDir } from "./tmpdir.js";

const created: string[] = [];
afterEach(async () => {
  while (created.length) {
    const d = created.pop();
    if (d) await rmDir(d);
  }
});

const ADDR = "Whale1111111111111111111111111111111111111111";

async function repoIn(tag: string) {
  const dir = await mkTmpDir(tag);
  created.push(dir);
  return createJsonFollowRepo({ filePath: path.join(dir, "follow-state.json"), logger: nullLogger });
}

function wallet(over: Partial<FollowedWallet> = {}): FollowedWallet {
  return {
    address: ADDR,
    label: "whale",
    enabled: true,
    addedAt: "2026-09-19T00:00:00.000Z",
    sizePctOverride: null,
    notes: null,
    ...over,
  };
}

function mirror(over: Partial<MirroredPosition> = {}): MirroredPosition {
  return {
    position: "pos-1",
    pool: "poolA",
    pool_name: "TKN/SOL",
    base_mint: "MINT_A",
    source_wallet: ADDR,
    source_label: "whale",
    source_position: null,
    opened_at: "2026-09-20T10:00:00.000Z",
    closed_at: null,
    close_reason: null,
    amount_sol: 1,
    lower_bin: 940,
    upper_bin: 1000,
    source_lower_bin: 940,
    source_upper_bin: 1000,
    source_deposit_sol: 50,
    entry_technicals: null,
    entry_context: null,
    exit_technicals: null,
    exit_context: null,
    source_pnl_pct: null,
    lesson_id: null,
    ...over,
  };
}

describe("JsonFollowRepo", () => {
  it("reads an absent file as empty", async () => {
    const repo = await repoIn("follow-empty");
    expect(await repo.listWallets()).toEqual([]);
    expect(await repo.getSeen(ADDR)).toBeNull();
  });

  it("round-trips a wallet through the file", async () => {
    const repo = await repoIn("follow-rt");
    await repo.addWallet(wallet());
    const list = await repo.listWallets();
    expect(list).toHaveLength(1);
    expect(list[0]!.label).toBe("whale");
  });

  it("upserts rather than duplicating on re-add", async () => {
    const repo = await repoIn("follow-upsert");
    await repo.addWallet(wallet());
    await repo.addWallet(wallet({ label: "renamed" }));
    const list = await repo.listWallets();
    expect(list).toHaveLength(1);
    expect(list[0]!.label).toBe("renamed");
  });

  it("distinguishes never-seeded (null) from seeded-but-empty ([])", async () => {
    const repo = await repoIn("follow-seed");
    expect(await repo.getSeen(ADDR)).toBeNull();
    await repo.setSeen(ADDR, []);
    expect(await repo.getSeen(ADDR)).toEqual([]);
    await repo.setSeen(ADDR, ["poolA"]);
    expect(await repo.getSeen(ADDR)).toEqual(["poolA"]);
  });

  it("clears the baseline on remove so a re-add never back-fills", async () => {
    const repo = await repoIn("follow-remove");
    await repo.addWallet(wallet());
    await repo.setSeen(ADDR, ["poolA"]);
    expect(await repo.removeWallet(ADDR)).toBe(true);
    expect(await repo.getSeen(ADDR)).toBeNull();
    expect(await repo.removeWallet(ADDR)).toBe(false);
  });

  it("clears the baseline when a wallet is re-enabled", async () => {
    const repo = await repoIn("follow-toggle");
    await repo.addWallet(wallet());
    await repo.setSeen(ADDR, ["poolA"]);
    expect(await repo.setWalletEnabled(ADDR, false)).toBe(true);
    // Disabling keeps the baseline; re-enabling drops it so the next tick re-seeds.
    expect(await repo.getSeen(ADDR)).toEqual(["poolA"]);
    await repo.setWalletEnabled(ADDR, true);
    expect(await repo.getSeen(ADDR)).toBeNull();
  });

  it("reports unknown addresses on setWalletEnabled", async () => {
    const repo = await repoIn("follow-unknown");
    expect(await repo.setWalletEnabled(ADDR, false)).toBe(false);
  });

  it("separates open from closed mirrors", async () => {
    const repo = await repoIn("follow-mirrors");
    await repo.addMirrored(mirror());
    await repo.addMirrored(mirror({ position: "pos-2", closed_at: "2026-09-20T11:00:00.000Z" }));
    expect(await repo.listMirrored()).toHaveLength(2);
    const open = await repo.listOpenMirrored();
    expect(open).toHaveLength(1);
    expect(open[0]!.position).toBe("pos-1");
  });

  it("merges a patch into an existing mirror record", async () => {
    const repo = await repoIn("follow-patch");
    await repo.addMirrored(mirror());
    expect(await repo.updateMirrored("pos-1", { lesson_id: "l-1" })).toBe(true);
    const rec = (await repo.listMirrored())[0]!;
    expect(rec.lesson_id).toBe("l-1");
    expect(rec.pool).toBe("poolA");
    expect(await repo.updateMirrored("nope", { lesson_id: "x" })).toBe(false);
  });
});
