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
