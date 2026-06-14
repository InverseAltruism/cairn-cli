// Thin client for a Cairn instance's HTTP API. Reads are public; writes need a token.
import { CAIRN_API, CAIRN_TOKEN, CAIRN_RPC } from "./config.js";

async function req(path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${CAIRN_API}${path}`, { signal: AbortSignal.timeout(8000), ...init });
  } catch (e: any) {
    throw new Error(`cannot reach ${CAIRN_API} (${e?.message ?? e}) — set CAIRN_API to a running Cairn instance`);
  }
  if (res.status === 401)
    throw new Error(`${CAIRN_API} is password-gated (401). Point CAIRN_API at a public instance or your own (e.g. http://127.0.0.1:7777)`);
  if (!res.ok) throw new Error(`API ${path} → HTTP ${res.status}`);
  return res.json();
}

function writeReq(path: string, body: unknown): Promise<any> {
  if (!CAIRN_TOKEN) throw new Error("posting needs a token — set CAIRN_TOKEN (the operator's write token)");
  return req(path, {
    method: "POST",
    // never follow a redirect on a write: undici keeps custom headers across cross-origin
    // 30x, so a hostile/MITM'd CAIRN_API could otherwise bounce the x-cairn-token to an
    // attacker host. Fail closed instead.
    redirect: "error",
    headers: { "content-type": "application/json", "x-cairn-token": CAIRN_TOKEN },
    body: JSON.stringify(body),
  });
}

export const apiHealth = () => req("/api/health");
export const apiDomains = () => req("/api/domains");
export const apiStats = () => req("/api/stats");
export const apiBoard = (domain: string, window: string) =>
  req(`/api/board?domain=${encodeURIComponent(domain)}&window=${encodeURIComponent(window)}`);
export const apiItem = (id: string) => req(`/api/item/${encodeURIComponent(id)}`);
export const apiActivity = () => req("/api/activity");
export const apiWall = () => req("/api/wall");
export const apiNetwork = () => req("/api/network");
export const apiProfile = (addr: string) => req(`/api/profile/${encodeURIComponent(addr)}`);
export const apiLeaderboard = () => req("/api/leaderboard");
export const apiQuests = () => req("/api/quests");
export const apiPropose = (body: { domain: string; title: string; body: string; links: string[]; fee: number }) =>
  writeReq("/api/propose", body);
export const apiSupport = (body: { id: string; fee: number; score: number; confidence: number }) =>
  writeReq("/api/support", body);

// ── proxy bridge: lets a node-less user transact via `csd`. We fetch a spendable input
//    + the chain tip from the Cairn instance's public /api/rpc/* proxy, hand the input to
//    `csd … --input`, and submit through `--rpc-url <CAIRN_API>/api/rpc`. ──
export const rpcBase = () => `${CAIRN_API}/api/rpc`;
// One confirmed, mature, non-coinbase UTXO worth > minValue (smallest sufficient) for addr,
// as the csd input triple "<txid>:<vout>:<value>" — or null.
// One confirmed, mature, non-coinbase UTXO worth > minValue (smallest sufficient) for addr.
// Returns { input: "<txid>:<vout>:<value>", value } — value is the proxy-reported amount the
// caller surfaces so the user sees the true implied fee (a hostile proxy under-reporting it
// only inflates the fee it burns to the miner; it can never redirect funds — change goes to
// the user's own --change addr). txid/vout are format-validated so a malformed value can't
// produce a junk (rejected) tx.
const HEX64 = /^0x?[0-9a-fA-F]{64}$/;
export async function pickInput(addr: string, minValue: number): Promise<{ input: string; value: number } | null> {
  const j = await req(`/api/rpc/utxos-all/${encodeURIComponent(addr)}`);
  const ok = (x: any) =>
    Number(x.confirmations ?? 0) >= 1 &&
    Number.isSafeInteger(Number(x.value)) && Number(x.value) > minValue &&
    Number.isInteger(Number(x.vout)) && Number(x.vout) >= 0 &&
    typeof x.txid === "string" && HEX64.test(x.txid) &&
    !x.coinbase;
  const cand = (j.utxos ?? []).filter(ok).sort((a: any, b: any) => Number(a.value) - Number(b.value));
  const x = cand[0] ?? (j.utxos ?? []).find(ok);
  return x ? { input: `${x.txid}:${Number(x.vout)}:${Number(x.value)}`, value: Number(x.value) } : null;
}
export async function confirmedBalance(addr: string): Promise<{ balance: number; utxos: number }> {
  const j = await req(`/api/rpc/utxos-all/${encodeURIComponent(addr)}`);
  return { balance: Number(j.confirmed_balance ?? 0), utxos: (j.utxos ?? []).length };
}
export async function tipHeight(): Promise<number> { return Number((await req("/api/rpc/tip")).height ?? 0); }
// Chain-view freshness of the proxy's backend node: { stale, secondsSinceAdvance, staleSecsThreshold, height }.
// Used to refuse building a tx against a frozen/forked tip. Throws if the surface is unreachable
// (caller treats that as a soft warning, never a hard block — matches the 'cannot reach' UX).
export async function rpcStatus(): Promise<{ stale?: boolean; secondsSinceAdvance?: number; staleSecsThreshold?: number; height?: number }> {
  return req("/api/rpc/status");
}
// Look up a tx by id on the node. Mined txs resolve to { ok:true, txid, block_hash, height };
// an unknown id resolves to { ok:false, err:"not found" }. (The node's /tx indexes MINED txs;
// a mempool-only tx returns not-found, so a not-found is "no proof yet", never "rejected".)
export async function txStatus(txid: string): Promise<{ ok: boolean; txid?: string; block_hash?: string | null; height?: number | null }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txid)) return { ok: false }; // never splice an unshaped id into the URL
  const j = await req(`/api/rpc/tx/${encodeURIComponent(txid)}`).catch(() => null);
  return j ?? { ok: false };
}
// Has the node confirmed OUR exact txid (mined into the chain)? Polls a few times because a
// freshly-submitted tx is mempool-only until a block lands. Returns true ONLY on an exact
// txid match the node reports as known — evidence the user's own tx (not a different conflict)
// is on-chain. (Non-fatal on an unreachable node: simply never confirms.) The poll budget is
// overridable via CAIRN_CONFIRM_ATTEMPTS / CAIRN_CONFIRM_INTERVAL_MS (used by the test suite).
export async function confirmTxMined(
  txid: string,
  attempts = Number(process.env.CAIRN_CONFIRM_ATTEMPTS) || 4,
  intervalMs = Number(process.env.CAIRN_CONFIRM_INTERVAL_MS) || 7000,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const s = await txStatus(txid).catch(() => null);
    if (s?.ok && typeof s.txid === "string" && s.txid.toLowerCase() === txid.toLowerCase()) return true;
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, intervalMs));
  }
  return false;
}
// Submit a node-JSON tx through the proxy (for `csd spend`, which builds+signs but doesn't
// reliably submit to a proxy URL). Returns the node's response.
export async function submitTx(txNodeJson: unknown): Promise<any> { return req("/api/rpc/tx/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: txNodeJson }) }); }
// Register a proposal's off-chain content (self-certifying; accepted once mined + hash-matched).
export async function registerContent(content: any, txid: string, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try { const r = await req("/api/content", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...content, txid }) }); if (r.ok) return true; } catch { /* keep trying while it mines */ }
    await new Promise((res) => setTimeout(res, 8000));
  }
  return false;
}

// Register an L3 registry record's EXACT canonical bytes (origin serves them verbatim;
// accepted only if sha256(bytes) == the on-chain payload_hash). Retries while it mines.
export async function registerRawContent(bytes: string, txid: string, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try { const r = await req("/api/content", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bytes, txid }) }); if (r.ok) return true; } catch { /* keep trying while it mines */ }
    await new Promise((res) => setTimeout(res, 8000));
  }
  return false;
}

// optional: query a raw csd node RPC (for trustless verify)
export async function chainProposal(id: string): Promise<any | null> {
  if (!CAIRN_RPC) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return null; // never splice an unshaped id into the URL
  try {
    const r = await fetch(`${CAIRN_RPC}/proposal/${encodeURIComponent(id)}`, { redirect: "error", signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.proposal ?? j ?? null;
  } catch {
    return null;
  }
}
