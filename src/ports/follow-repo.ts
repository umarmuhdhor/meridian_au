import type {
  FollowStateFile,
  FollowedWallet,
  MirroredPosition,
} from "../domain/schemas/follow-wallet.js";
import type { LoadError } from "../adapters/persistence/json/atomic-write.js";
import type { Result } from "../shared/result.js";

/**
 * Persistence for the follow-the-wallet feature. Holds three things that must stay
 * consistent with each other: the followed-wallet list, the last-seen pool set per
 * wallet (the diff baseline), and the open/closed mirror records.
 */
export interface FollowRepo {
  load(): Promise<Result<FollowStateFile, LoadError>>;

  listWallets(): Promise<FollowedWallet[]>;
  /** Upsert by address. */
  addWallet(wallet: FollowedWallet): Promise<void>;
  removeWallet(address: string): Promise<boolean>;
  /** Flip `enabled` for one wallet. Returns false when the address is unknown. */
  setWalletEnabled(address: string, enabled: boolean): Promise<boolean>;

  /** Last observed open-pool set for a wallet, or null when never seeded. */
  getSeen(address: string): Promise<string[] | null>;
  /** Replace the seen-set and mark the wallet seeded. */
  setSeen(address: string, pools: string[]): Promise<void>;

  listMirrored(): Promise<MirroredPosition[]>;
  /** Only the records still marked open. */
  listOpenMirrored(): Promise<MirroredPosition[]>;
  addMirrored(record: MirroredPosition): Promise<void>;
  /** Merge a patch into the record with this position address. */
  updateMirrored(position: string, patch: Partial<MirroredPosition>): Promise<boolean>;
}
