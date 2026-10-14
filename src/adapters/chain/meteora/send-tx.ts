/**
 * "Expired" is not "failed". web3.js `sendAndConfirmTransaction` throws
 * `TransactionExpiredBlockheightExceededError` / `TransactionExpiredTimeoutError` when it
 * could not SEE a confirmation before the blockhash expired — the tx itself may still
 * have landed (slow RPC). Reporting that as a failure skipped every close post-hook:
 * no History record, no auto-swap, no cooldown, and the position only resurfaced later
 * as a "reconciled: no longer on-chain" ghost (Altai-SOL, 2026-10-14).
 *
 * So on an expiry error we ask the cluster for the signature's status (with tx history)
 * a few times; landed without error → return the signature as a success. Anything else
 * (status never appears, or landed WITH an error) rethrows the original error.
 */

export interface SignatureStatusLite {
  err: unknown;
  confirmationStatus?: string | null;
}

export type GetSignatureStatus = (signature: string) => Promise<SignatureStatusLite | null>;

export interface RecoverExpiryOpts {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRecovered?: (signature: string) => void;
}

/** Signature carried by a web3.js expiry error, or null for any other error. */
export function expiredSignature(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const sig = (err as { signature?: unknown }).signature;
  if (typeof sig !== "string" || !sig) return null;
  return /expired/i.test(err.message) ? sig : null;
}

export async function sendRecoveringExpiry(
  send: () => Promise<string>,
  getStatus: GetSignatureStatus,
  opts: RecoverExpiryOpts = {},
): Promise<string> {
  try {
    return await send();
  } catch (err) {
    const signature = expiredSignature(err);
    if (!signature) throw err;
    const attempts = opts.attempts ?? 5;
    const delayMs = opts.delayMs ?? 2_000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < attempts; i++) {
      const status = await getStatus(signature).catch(() => null);
      if (status) {
        if (status.err != null) throw err;
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          opts.onRecovered?.(signature);
          return signature;
        }
      }
      if (i < attempts - 1) await sleep(delayMs);
    }
    throw err;
  }
}
