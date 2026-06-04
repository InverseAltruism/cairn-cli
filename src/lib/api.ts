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
export async function pickInput(addr: string, minValue: number): Promise<string | null> {
  const j = await req(`/api/rpc/utxos-all/${encodeURIComponent(addr)}`);
  const ok = (x: any) => Number(x.confirmations ?? 0) >= 1 && Number.isSafeInteger(Number(x.value)) && Number(x.value) > minValue && !x.coinbase;
  const cand = (j.utxos ?? []).filter(ok).sort((a: any, b: any) => Number(a.value) - Number(b.value));
  const x = cand[0] ?? (j.utxos ?? []).find(ok);
  return x ? `${x.txid}:${Number(x.vout)}:${Number(x.value)}` : null;
}
export async function confirmedBalance(addr: string): Promise<{ balance: number; utxos: number }> {
  const j = await req(`/api/rpc/utxos-all/${encodeURIComponent(addr)}`);
  return { balance: Number(j.confirmed_balance ?? 0), utxos: (j.utxos ?? []).length };
}
export async function tipHeight(): Promise<number> { return Number((await req("/api/rpc/tip")).height ?? 0); }
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

// optional: query a raw csd node RPC (for trustless verify)
export async function chainProposal(id: string): Promise<any | null> {
  if (!CAIRN_RPC) return null;
  try {
    const r = await fetch(`${CAIRN_RPC}/proposal/${id}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.proposal ?? j ?? null;
  } catch {
    return null;
  }
}
