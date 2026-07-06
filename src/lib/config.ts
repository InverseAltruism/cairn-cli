// cairn-cli configuration (env-overridable).
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";

export const CAIRN_API = (process.env.CAIRN_API ?? "https://cairn-substrate.com").replace(/\/+$/, "");
export const CAIRN_TOKEN = process.env.CAIRN_TOKEN ?? ""; // optional operator write token (falls back to local csd wallet)
export const CAIRN_RPC = process.env.CAIRN_RPC ?? ""; // optional: a csd node RPC, enables trustless verify
export const CAIRN_CSD = process.env.CAIRN_CSD ?? "csd"; // the user's installed `csd` binary (signs with their wallet)
export const CAIRN_ADDR = process.env.CAIRN_ADDR ?? ""; // optional: your public addr20 (skips deriving it from csd)

export const CSD_PER_COIN = 100_000_000;
// Consensus fee floors come from the pinned codec (shared-core de-dup) — cairnx.ts already
// imports MIN_FEE_PROPOSE from the same package; re-exported here so callers keep one import site.
export { MIN_FEE_PROPOSE, MIN_FEE_ATTEST } from "@inversealtruism/csd-codec"; // 0.25 / 0.05 CSD

export function csdToCoins(base: number): string {
  return (base / CSD_PER_COIN).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// small local config: caches ONLY the user's public address (never a key). Written with
// owner-only perms (dir 0700, file 0600) so another local user can't poison the cached address
// to redirect `cairn address` output (F13/R18 — the wallet is still the source of truth).
const CFG_PATH = process.env.CAIRN_CLI_CONFIG ?? join(homedir(), ".config", "cairn-cli", "config.json");
export function loadLocalConfig(): { address?: string } { try { return JSON.parse(readFileSync(CFG_PATH, "utf8")); } catch { return {}; } }
// Returns true iff the address was durably persisted. CLI-C2: a SILENT failure here breaks the
// H-2 "derive the key-on-argv address at most once" guarantee — a read-only HOME / unwritable
// CAIRN_CLI_CONFIG / full disk would make every subsequent call re-derive (re-exposing the key on
// the csd argv). Callers surface a warning on false so the user can fix the cache (or stop deriving).
export function saveLocalConfig(patch: { address?: string }): boolean {
  try {
    mkdirSync(dirname(CFG_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(CFG_PATH, JSON.stringify({ ...loadLocalConfig(), ...patch }, null, 2) + "\n", { mode: 0o600 });
    chmodSync(CFG_PATH, 0o600); // tighten even if the file pre-existed (writeFileSync mode is create-only)
    return true;
  } catch { return false; }
}
