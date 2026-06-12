// CairnX — the token + .csd-name layer that lives entirely in CSD Propose records on the
// `cairnx:v1` domain. This file is the CLI's complete CairnX surface:
//   • a READ client for the CairnX state API (resolution order: $CAIRNX_API → the local
//     service → the public gateway, GET-only) with automatic fallback on network failure
//   • the canonical TRANSFER record builder — hand-rolled on the repo's own
//     stableStringify/sha256 (byte-exact-tested against cairnx-core's ground truth) so the
//     CLI takes NO dependency on the private cairnx repo.
//     TODO: swap to @inversealtruism/cairnx-core once it is published to npm.
//   • exact human↔base-unit amount math as STRING/BigInt arithmetic — floats never touch
//     token amounts (no "1.1 * 1e8 = 110000000.00000001" class of bug, no silent truncation).
import { stableStringify, sha256Hex } from "./item.js";

export const CAIRNX_DOMAIN = "cairnx:v1";
export const CAIRNX_ANCHOR_FEE = 25_000_000; // 0.25 CSD — the consensus min Propose fee that anchors a record
export const MAX_AMOUNT = (1n << 96n) - 1n; // CONVENTION.md: token amounts are ≤ 96-bit
const MAX_RECORD_BYTES = 512; // consensus MAX_URI_BYTES — the record must fit in `uri`

// Validation shapes (mirrors CONVENTION.md §4 — kept in sync by the byte-exact fixtures).
export const TICKER_RE = /^[A-Z][A-Z0-9]{2,11}$/;
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/; // a claimable .csd name
const ADDR_RE = /^0x[0-9a-f]{40}$/; // records carry LOWERCASE addresses

// ── canonical transfer record ─────────────────────────────────────────────────────────────
// A token transfer is a Propose on cairnx:v1 whose uri IS the record:
//   {"amount":"<base>","t":"transfer","ticker":"T","to":"0x…","v":1}
// (recursively sorted keys, no whitespace) and payload_hash = sha256(uri). The resolver
// treats any malformed record as a no-op, so we validate strictly BEFORE spending the fee.
export interface BuiltTransfer {
  record: { amount: string; t: "transfer"; ticker: string; to: string; v: 1 };
  uri: string;
  payloadHash: string;
}
export function buildTransferRecord(p: { ticker: string; to: string; amount: bigint }): BuiltTransfer {
  const to = String(p.to).toLowerCase();
  if (!TICKER_RE.test(p.ticker)) throw new Error(`bad ticker "${p.ticker}" — want 3–12 chars [A-Z0-9], starting with a letter`);
  if (!ADDR_RE.test(to)) throw new Error(`bad recipient "${p.to}" — want a 0x… 20-byte address`);
  if (p.amount <= 0n) throw new Error("amount must be > 0");
  if (p.amount > MAX_AMOUNT) throw new Error("amount exceeds the 96-bit token-amount limit");
  const record = { amount: p.amount.toString(), t: "transfer" as const, ticker: p.ticker, to, v: 1 as const };
  const uri = stableStringify(record);
  if (Buffer.byteLength(uri, "utf8") > MAX_RECORD_BYTES) throw new Error("record exceeds 512 bytes"); // unreachable for a transfer, kept as a guard
  return { record, uri, payloadHash: sha256Hex(uri) };
}

// ── exact amount math (strings + BigInt only) ─────────────────────────────────────────────
// "1.5" with decimals 8 → 150000000n. Fails LOUDLY instead of truncating: "1.5" on a
// 0-decimals token is an error, not 1. Trailing fractional zeros are exact and accepted
// ("1.50" @ 1 decimal → 15n).
export function humanToBase(human: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error(`bad token decimals ${decimals}`);
  const s = String(human).trim();
  if (s.length === 0 || s.length > 40) throw new Error(`bad amount "${human}"`); // MAX_AMOUNT is 29 digits; cap before BigInt
  const m = /^([0-9]+)?(?:\.([0-9]+))?$/.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined)) throw new Error(`bad amount "${human}" — use plain digits like 1 or 1.25`);
  const frac = (m[2] ?? "").replace(/0+$/, ""); // trailing zeros are exactly representable — drop them
  if (frac.length > decimals) throw new Error(`amount "${human}" has more decimal places than this token allows (${decimals})`);
  const base = BigInt(m[1] ?? "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (base > MAX_AMOUNT) throw new Error(`amount "${human}" exceeds the 96-bit token-amount limit`);
  return base;
}
// 150000000n @ 8 → "1.5" (exact inverse of humanToBase; no grouping — display adds that).
export function baseToHuman(base: bigint | string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error(`bad token decimals ${decimals}`);
  const v = typeof base === "bigint" ? base : BigInt(String(base));
  if (v < 0n) throw new Error("negative token amount");
  const s = v.toString().padStart(decimals + 1, "0");
  const int = decimals ? s.slice(0, -decimals) : s;
  const fr = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return fr ? `${int}.${fr}` : int;
}

// ── read API client (GET-only; never sees a key) ──────────────────────────────────────────
// Base resolution order: $CAIRNX_API (explicit choice — used exclusively), else the local
// CairnX service, else the public gateway. Read at call time (not import) so tests can vary it.
export function defaultBases(): string[] {
  const env = (process.env.CAIRNX_API ?? "").trim().replace(/\/+$/, "");
  if (env) return [env];
  return ["http://127.0.0.1:8794/cairnx", "https://cairn-substrate.com/trade/api/cairnx"];
}
// Remember the first base that answered (per base-list) so one command's N requests don't
// re-probe a dead localhost N times.
let active: { key: string; base: string } | null = null;
export const activeCairnxBase = (): string | null => active?.base ?? null;

export async function cairnxGet(path: string, bases: string[] = defaultBases()): Promise<any> {
  const key = bases.join(" ");
  const order = active?.key === key && bases.includes(active.base)
    ? [active.base, ...bases.filter((b) => b !== active!.base)] : bases;
  let lastErr: any = null;
  for (const base of order) {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8000) }); // GET-only, no credentials — redirects are safe to follow
    } catch (e: any) { lastErr = e; continue; } // network failure → try the next base
    // A reachable base's answer is authoritative — an HTTP 404 here is a real "not found",
    // never a reason to fall through to a different (possibly divergent) view of state.
    active = { key, base };
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      const e: any = new Error(j?.error ? String(j.error) : `CairnX API ${path} → HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }
  throw new Error(`cannot reach a CairnX API (tried ${bases.join(", ")}) — set CAIRNX_API (${lastErr?.message ?? lastErr})`);
}
