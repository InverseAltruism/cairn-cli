// Thin wrapper around the user's INSTALLED `csd` CLI. cairn-cli never holds a private
// key: for any write it shells out to `csd`, which signs with the user's own csd wallet
// config key (CSD_SIG_V1). We only orchestrate — supply the input (fetched from the Cairn
// proxy, so no local node is required) + the Cairn payload — and `csd` does the signing.
//
// SECURITY (audit H-1): which `csd` binary signs is a trust decision. A bare `csd` resolved
// by $PATH order lets a malicious binary planted earlier on PATH (dev env, npm postinstall,
// shared host) capture the wallet key the instant cairn shells out. So:
//   • CAIRN_CSD, if set, is the user's EXPLICIT choice — honored, but MUST be absolute.
//   • Otherwise we resolve `csd` from a list of CANONICAL absolute locations FIRST (not PATH
//     order), fall back to a PATH search only if none exists, REFUSE a binary in a world-
//     writable / transient / cwd location, and SURFACE the resolved absolute path so the user
//     can see which binary signs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync, realpathSync } from "node:fs";
import { isAbsolute, join, dirname, delimiter } from "node:path";
const pexec = promisify(execFile);

// Back-compat hint (the configured name/path); real resolution is resolveCsdBin().
export const CSD_BIN = process.env.CAIRN_CSD || "csd";
export interface CsdResult { ok: boolean; stdout: string; stderr: string; txid?: string }

// Canonical absolute install locations, checked in order BEFORE any $PATH search so a binary
// planted earlier on PATH cannot win.
const HOME = process.env.HOME || "";
const CANONICAL = [
  "/usr/local/bin/csd", "/usr/bin/csd", "/opt/substrate_miner/bin/csd",
  ...(HOME ? [join(HOME, ".cargo/bin/csd"), join(HOME, ".local/bin/csd")] : []),
];

// Is this resolved path attacker-plantable? Returns a human reason, or null if it looks safe.
function insecureReason(abs: string): string | null {
  let st;
  try { st = statSync(abs); } catch { return "does not exist"; }
  if (!st.isFile()) return "is not a regular file";
  if (st.mode & 0o002) return "is world-writable";
  const dir = dirname(abs);
  try {
    const dst = statSync(dir);
    if ((dst.mode & 0o002) && !(dst.mode & 0o1000)) return `is in a world-writable directory (${dir})`;
  } catch { /* dir unreadable — fall through */ }
  if (dir === process.cwd()) return "is in the current working directory (a cwd hijack vector)";
  if (dir.startsWith("/tmp") || dir.startsWith("/var/tmp") || dir.startsWith("/dev/shm")) return `is in a transient directory (${dir})`;
  return null;
}

function pathSearch(name: string): string | null {
  for (const d of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const p = join(d, name);
    try { const st = statSync(p); if (st.isFile() && (st.mode & 0o111)) return p; } catch { /* keep looking */ }
  }
  return null;
}

let _resolved: { path: string | null; warning?: string; error?: string; explicit: boolean } | null = null;
// Resolve (and cache) the trusted `csd` path. See header for the policy.
export function resolveCsdBin(): { path: string | null; warning?: string; error?: string; explicit: boolean } {
  if (_resolved) return _resolved;
  const env = process.env.CAIRN_CSD;
  if (env) {
    // Explicit user choice. Require absolute (a relative explicit path is still PATH/cwd-hijackable);
    // honor it even in an unusual location (the user told us exactly which binary to trust), but warn
    // if world-writable. We do NOT refuse here — the test harness and power users point CAIRN_CSD at
    // bespoke absolute paths deliberately.
    if (!isAbsolute(env)) return (_resolved = { path: null, explicit: true, error: `CAIRN_CSD must be an ABSOLUTE path (got "${env}") — a relative csd binary is a key-theft risk` });
    let abs = env; try { abs = realpathSync(env); } catch { /* may legitimately not exist yet — surfaced at run/available */ }
    let warning: string | undefined;
    try { if (statSync(abs).mode & 0o002) warning = `CAIRN_CSD (${abs}) is world-writable — anyone could replace it with a key-stealing binary`; } catch { /* */ }
    return (_resolved = { path: abs, explicit: true, warning });
  }
  // Implicit resolution: canonical locations first (defeats PATH-order hijack), then PATH.
  for (const cand of CANONICAL) {
    try { const st = statSync(cand); if (st.isFile() && (st.mode & 0o111) && !insecureReason(cand)) return (_resolved = { path: realpathSync(cand), explicit: false }); } catch { /* next */ }
  }
  const found = pathSearch("csd");
  if (!found) return (_resolved = { path: null, explicit: false, error: "`csd` not found in any trusted location or on PATH — install it, or set CAIRN_CSD to its absolute path" });
  let abs: string; try { abs = realpathSync(found); } catch { return (_resolved = { path: null, explicit: false, error: `csd at ${found} could not be resolved` }); }
  const bad = insecureReason(abs);
  if (bad) return (_resolved = { path: null, explicit: false, error: `refusing to run csd at ${abs} — it ${bad}. A malicious csd there could steal your wallet key. Move it to a trusted location (e.g. /usr/local/bin) or set CAIRN_CSD to a trusted absolute path.` });
  return (_resolved = { path: abs, explicit: false });
}
// For display (the `setup` command shows the user exactly which binary will sign).
export function csdPathInfo(): { path: string | null; warning?: string; error?: string; explicit: boolean } { return resolveCsdBin(); }

function extractTxid(s: string): string | undefined {
  const m = s.match(/txid["':\s]+0x([0-9a-fA-F]{64})/) || s.match(/0x[0-9a-fA-F]{64}/);
  return m ? (m[1] ? "0x" + m[1] : m[0]) : undefined;
}
export async function run(args: string[]): Promise<CsdResult> {
  const bin = resolveCsdBin();
  if (!bin.path) return { ok: false, stdout: "", stderr: bin.error || "csd unavailable" };
  try { const { stdout, stderr } = await pexec(bin.path, args, { timeout: 30000 }); return { ok: true, stdout, stderr, txid: extractTxid(stdout + stderr) }; }
  catch (e: any) { const out = (e.stdout ?? "") + (e.stderr ?? ""); return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message ?? e), txid: extractTxid(out) }; }
}
// Is `csd` installed + runnable (at the trusted path)?
export async function available(): Promise<boolean> { const bin = resolveCsdBin(); if (!bin.path) return false; try { await pexec(bin.path, ["--version"], { timeout: 5000 }); return true; } catch { return false; } }
// The user's csd wallet config (default_privkey / default_rpc_url / …). null if csd absent.
export async function walletConfig(): Promise<any | null> { const r = await run(["wallet", "config"]); if (!r.ok) return null; try { return JSON.parse(r.stdout); } catch { return null; } }
// Derive the public addr20 from a privkey via `csd wallet recover`.
// SECURITY (audit H-2): this puts --privkey on the csd argv, briefly readable via /proc on a
// shared host. It is a LAST resort — resolveAddr() only calls it when the wallet has no
// default_change_addr20 AND we have no cached address, and the result is cached so it happens at
// most once. Callers surface keyExposureWarning and recommend setting a change address.
export async function deriveAddr(priv: string): Promise<string | null> { const r = await run(["wallet", "recover", "--privkey", priv]); const m = r.stdout.match(/addr20:\s*(0x[0-9a-fA-F]{40})/i); return m ? m[1] : null; }
export const keyExposureWarning = "deriving your address from the wallet key briefly exposes it on the `csd` command line (readable via /proc on a shared host). Set a change address once — `csd wallet init --privkey <key>` — so cairn never needs the key again.";
