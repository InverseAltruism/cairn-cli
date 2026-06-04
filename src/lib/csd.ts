// Thin wrapper around the user's INSTALLED `csd` CLI. cairn-cli never holds a private
// key: for any write it shells out to `csd`, which signs with the user's own csd wallet
// config key (CSD_SIG_V1). We only orchestrate — supply the input (fetched from the Cairn
// proxy, so no local node is required) + the Cairn payload — and `csd` does the signing
// and submit. Binary resolution: CAIRN_CSD env → `csd` on PATH → the substrate default.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);

export const CSD_BIN = process.env.CAIRN_CSD || "csd";
export interface CsdResult { ok: boolean; stdout: string; stderr: string; txid?: string }

function extractTxid(s: string): string | undefined {
  const m = s.match(/txid["':\s]+0x([0-9a-fA-F]{64})/) || s.match(/0x[0-9a-fA-F]{64}/);
  return m ? (m[1] ? "0x" + m[1] : m[0]) : undefined;
}
export async function run(args: string[]): Promise<CsdResult> {
  try { const { stdout, stderr } = await pexec(CSD_BIN, args, { timeout: 30000 }); return { ok: true, stdout, stderr, txid: extractTxid(stdout + stderr) }; }
  catch (e: any) { const out = (e.stdout ?? "") + (e.stderr ?? ""); return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message ?? e), txid: extractTxid(out) }; }
}
// Is `csd` installed + runnable?
export async function available(): Promise<boolean> { try { await pexec(CSD_BIN, ["--version"], { timeout: 5000 }); return true; } catch { return false; } }
// The user's csd wallet config (default_privkey / default_rpc_url / …). null if csd absent.
export async function walletConfig(): Promise<any | null> { const r = await run(["wallet", "config"]); if (!r.ok) return null; try { return JSON.parse(r.stdout); } catch { return null; } }
// Derive the public addr20 from a privkey via `csd wallet recover` (local; key never networked).
export async function deriveAddr(priv: string): Promise<string | null> { const r = await run(["wallet", "recover", "--privkey", priv]); const m = r.stdout.match(/addr20:\s*(0x[0-9a-fA-F]{40})/i); return m ? m[1] : null; }
