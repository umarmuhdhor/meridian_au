import type { FollowRepo } from "../../../ports/follow-repo.js";
import type { Logger } from "../../../ports/logger.js";
import {
  emptyFollowStateFile,
  FollowStateFileSchema,
  MAX_MIRRORED_RECORDS,
  type FollowStateFile,
  type FollowedWallet,
  type MirroredPosition,
} from "../../../domain/schemas/follow-wallet.js";
import {
  formatLoadError,
  readJsonValidated,
  writeJsonAtomic,
  type LoadError,
} from "./atomic-write.js";
import { err, ok, type Result } from "../../../shared/result.js";

export interface JsonFollowRepoOptions {
  filePath: string;
  logger: Logger;
}

/**
 * JSON-backed FollowRepo over `follow-state.json`. Same contract as the other repos:
 * missing file reads as empty, a corrupt file surfaces as an error Result rather than
 * a throw, and every write is temp+fsync+rename (the file lives in the state DIRECTORY,
 * so rename is safe — see CLAUDE.md § bind-mount inode detach).
 */
export function createJsonFollowRepo(opts: JsonFollowRepoOptions): FollowRepo {
  const { filePath, logger } = opts;

  async function loadOrEmpty(): Promise<Result<FollowStateFile, LoadError>> {
    const r = await readJsonValidated(filePath, FollowStateFileSchema);
    if (r.ok) return r;
    if (r.error.kind === "not_found") return ok(emptyFollowStateFile());
    logger.error("follow", formatLoadError(r.error));
    return err(r.error);
  }

  async function mutate(fn: (file: FollowStateFile) => void | boolean): Promise<boolean> {
    const r = await loadOrEmpty();
    const file = r.ok ? r.value : emptyFollowStateFile();
    const outcome = fn(file);
    if (outcome === false) return false;
    await writeJsonAtomic(filePath, file);
    return true;
  }

  return {
    async load() {
      return loadOrEmpty();
    },

    async listWallets(): Promise<FollowedWallet[]> {
      const r = await loadOrEmpty();
      return r.ok ? r.value.wallets : [];
    },

    async addWallet(wallet: FollowedWallet): Promise<void> {
      await mutate((file) => {
        const idx = file.wallets.findIndex((w) => w.address === wallet.address);
        if (idx === -1) file.wallets.push(wallet);
        else file.wallets[idx] = { ...file.wallets[idx], ...wallet };
      });
    },

    async removeWallet(address: string): Promise<boolean> {
      return mutate((file) => {
        const before = file.wallets.length;
        file.wallets = file.wallets.filter((w) => w.address !== address);
        if (file.wallets.length === before) return false;
        // Drop the diff baseline too — re-adding the wallet must re-seed, never
        // replay every pool it is already in as a fresh "open".
        delete file.seen[address];
        file.seeded = file.seeded.filter((a) => a !== address);
        return true;
      });
    },

    async setWalletEnabled(address: string, enabled: boolean): Promise<boolean> {
      return mutate((file) => {
        const w = file.wallets.find((x) => x.address === address);
        if (!w) return false;
        w.enabled = enabled;
        // Re-enabling must not replay positions opened while the wallet was off.
        // Clearing the seeded flag forces the next tick to re-seed silently.
        if (enabled) {
          delete file.seen[address];
          file.seeded = file.seeded.filter((a) => a !== address);
        }
        return true;
      });
    },

    async getSeen(address: string): Promise<string[] | null> {
      const r = await loadOrEmpty();
      if (!r.ok) return null;
      if (!r.value.seeded.includes(address)) return null;
      return r.value.seen[address] ?? [];
    },

    async setSeen(address: string, pools: string[]): Promise<void> {
      await mutate((file) => {
        file.seen[address] = pools;
        if (!file.seeded.includes(address)) file.seeded.push(address);
      });
    },

    async listMirrored(): Promise<MirroredPosition[]> {
      const r = await loadOrEmpty();
      return r.ok ? r.value.mirrored : [];
    },

    async listOpenMirrored(): Promise<MirroredPosition[]> {
      const r = await loadOrEmpty();
      return r.ok ? r.value.mirrored.filter((m) => m.closed_at == null) : [];
    },

    async addMirrored(record: MirroredPosition): Promise<void> {
      await mutate((file) => {
        const idx = file.mirrored.findIndex((m) => m.position === record.position);
        if (idx === -1) file.mirrored.push(record);
        else file.mirrored[idx] = { ...file.mirrored[idx], ...record };
        // Prune oldest CLOSED records only — an open mirror must never be evicted,
        // or its close would go unnoticed forever.
        const overflow = file.mirrored.length - MAX_MIRRORED_RECORDS;
        if (overflow > 0) {
          let toDrop = overflow;
          file.mirrored = file.mirrored.filter((m) => {
            if (toDrop > 0 && m.closed_at != null) {
              toDrop--;
              return false;
            }
            return true;
          });
        }
      });
    },

    async updateMirrored(position: string, patch: Partial<MirroredPosition>): Promise<boolean> {
      return mutate((file) => {
        const idx = file.mirrored.findIndex((m) => m.position === position);
        if (idx === -1) return false;
        file.mirrored[idx] = { ...file.mirrored[idx], ...patch } as MirroredPosition;
        return true;
      });
    },
  };
}
