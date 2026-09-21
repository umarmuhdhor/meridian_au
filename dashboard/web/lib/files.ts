import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Read-only access to the daemon's root JSON state files via fs.
// Whitelist + redaction MUST mirror the bridge exactly (reference.md §3/§8).

// :name → file at repo root.
export const FILE_WHITELIST: Record<string, string> = {
  "lessons": "lessons.json",
  "decision-log": "decision-log.json",
  "pool-memory": "pool-memory.json",
  "signal-weights": "signal-weights.json",
  "strategy-library": "strategy-library.json",
  "smart-wallets": "smart-wallets.json",
  "token-blacklist": "token-blacklist.json",
  "dev-blocklist": "dev-blocklist.json",
  "state": "state.json",
  "follow-state": "follow-state.json",
  "user-config": "user-config.json",
};

// Redaction DISABLED by owner request (2026-07-13): single-owner dashboard behind
// Cloudflare Access + PIN; the owner wants every value visible/editable, keys
// included. Identity passthrough — mirror of src/adapters/dashboard/redact.ts.
export function redactSecrets(v: unknown): unknown {
  return v;
}

// dashboard/web → ../.. = repo root, unless MERIDIAN_ROOT overrides.
function meridianRoot(): string {
  return process.env.MERIDIAN_ROOT || path.resolve(process.cwd(), "../..");
}

export function isWhitelistedFile(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FILE_WHITELIST, name);
}

// Returns parsed JSON (redacted for user-config), or null if the file is missing.
// Throws only on a non-whitelisted name (caller maps to 400).
export async function readRootJson(name: string): Promise<unknown> {
  const file = FILE_WHITELIST[name];
  if (!file) throw new Error("invalid file name");
  try {
    const raw = await readFile(path.join(meridianRoot(), file), "utf8");
    const data = JSON.parse(raw);
    return name === "user-config" ? redactSecrets(data) : data;
  } catch {
    return null; // missing/unreadable file → treat as empty
  }
}
