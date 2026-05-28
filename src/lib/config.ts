// cairn-cli configuration (env-overridable).
export const CAIRN_API = (process.env.CAIRN_API ?? "https://cairn-substrate.com").replace(/\/+$/, "");
export const CAIRN_TOKEN = process.env.CAIRN_TOKEN ?? ""; // required only for posting
export const CAIRN_RPC = process.env.CAIRN_RPC ?? ""; // optional: a csd node RPC, enables trustless verify

export const CSD_PER_COIN = 100_000_000;
export const MIN_FEE_PROPOSE = 25_000_000; // 0.25 CSD
export const MIN_FEE_ATTEST = 5_000_000; // 0.05 CSD

export function csdToCoins(base: number): string {
  return (base / CSD_PER_COIN).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
