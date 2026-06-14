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
export const MIN_FEE_PROPOSE = 25_000_000; // 0.25 CSD
export const MIN_FEE_ATTEST = 5_000_000; // 0.05 CSD

export function csdToCoins(base: number): string {
  return (base / CSD_PER_COIN).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// small local config: caches ONLY the user's public address (never a key). Written with
// owner-only perms (dir 0700, file 0600) so another local user can't poison the cached address
// to redirect `cairn address` output (F13/R18 — the wallet is still the source of truth).
const CFG_PATH = process.env.CAIRN_CLI_CONFIG ?? join(homedir(), ".config", "cairn-cli", "config.json");
export function loadLocalConfig(): { address?: string } { try { return JSON.parse(readFileSync(CFG_PATH, "utf8")); } catch { return {}; } }
export function saveLocalConfig(patch: { address?: string }): void {
  try {
    mkdirSync(dirname(CFG_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(CFG_PATH, JSON.stringify({ ...loadLocalConfig(), ...patch }, null, 2) + "\n", { mode: 0o600 });
    chmodSync(CFG_PATH, 0o600); // tighten even if the file pre-existed (writeFileSync mode is create-only)
  } catch { /* best-effort */ }
}
