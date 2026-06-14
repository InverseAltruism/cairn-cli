// Security / pen-test suite for cairn-cli. Stands up a HOSTILE in-process HTTP server
// (a malicious Cairn API + RPC) and points the real built CLI at it, asserting that:
//   • attacker-controlled strings can't inject terminal escapes (ANSI/OSC spoofing)
//   • a forged item can't be made to read "VERIFIED — trustless" when RPC == API host
//   • a malformed txid from the proxy is rejected (never spliced into a csd --input)
//   • san() strips control chars
// Uses ASYNC spawn (not spawnSync): the in-process mock server shares this event loop, so
// the parent must NOT block while the child runs its requests. No real chain, no spending.
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

// A mock `csd` binary: answers --version / wallet config / wallet recover / and the build/sign
// subcommands (spend/attest/propose) with a deterministic signed-tx JSON. Lets us drive the
// real submit→confirm path (R17) and the wallet-address re-derivation path (F13/R18) WITHOUT a
// real chain or key. WALLET_ADDR is the address the mock wallet config reports.
const WALLET_ADDR = "0x" + "a1".repeat(20);
const TX_TXID = "0x" + "7e".repeat(32);   // a tx the node has NO proof of (the conflict case)
const MINED_TXID = "0x" + "3d".repeat(32); // a tx the node DOES confirm as mined (the happy case)
const tmp = mkdtempSync(join(tmpdir(), "cairn-cli-csd-"));
const mkCsd = (name, txid) => {
  const p = join(tmp, name);
  writeFileSync(p, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "--version") { process.stdout.write("csd-mock 0.0.0\\n"); process.exit(0); }
if (a[0] === "wallet" && a[1] === "config") { process.stdout.write(JSON.stringify({ default_privkey: "deadbeef", default_change_addr20: "${WALLET_ADDR}" })); process.exit(0); }
if (a[0] === "wallet" && a[1] === "recover") { process.stdout.write("addr20: ${WALLET_ADDR}\\n"); process.exit(0); }
if (a[0] === "spend" || a[0] === "attest" || a[0] === "propose") {
  process.stdout.write(JSON.stringify({ tx: { version: 1, signed: true }, txid: "${txid}" })); process.exit(0);
}
process.stderr.write("mock csd: unknown command\\n"); process.exit(1);
`);
  chmodSync(p, 0o755);
  return p;
};
const MOCK_CSD = mkCsd("csd", TX_TXID);             // conflict-then-unconfirmed → must FAIL
const MOCK_CSD_MINED = mkCsd("csd-mined", MINED_TXID); // conflict-then-confirmed → must SUCCEED
let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log((c ? "  ✅ " : "  ❌ ") + n); };
const hasESC = (s) => /\x1b|\x07|\x9b/.test(s); // ESC, BEL, CSI
function run(args, env = {}) {
  return new Promise((resolve) => {
    const ch = spawn("node", [CLI, ...args], { env: { ...process.env, NO_COLOR: "1", CAIRN_CSD: "/nonexistent/csd", CAIRN_ADDR: "", CAIRN_CLI_CONFIG: "/nonexistent/cfg.json", ...env } });
    let out = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (out += d));
    ch.on("close", () => resolve({ out }));
    setTimeout(() => ch.kill("SIGKILL"), 18000);
  });
}

const EVIL = "\x1b[2J\x1b[1;1Hpwned\x1b]0;hijack\x07\x1b[31mFAKE";
const FORGED_HASH = "0x" + "ff".repeat(32);
const EVIL_ITEM = {
  id: "0x" + "ab".repeat(32), domain: "csd:test" + EVIL, title: "title" + EVIL, body: "body" + EVIL,
  links: ["http://x" + EVIL], proposer: "0x" + "11".repeat(20), proposerHandle: "handle" + EVIL,
  payloadHash: FORGED_HASH, source: "chain", totalWeight: 1, supporterCount: 1, avgScore: 9, createdTime: 0,
};
// A WELL-FORMED item: its content actually hashes to payloadHash (precomputed via buildCommitment),
// so a verify against a matching chain proposal reaches the independence branch — the only thing
// that can still withhold the "trustless" wording is the same-machine RPC check (F11).
const GOOD_ID = "0x" + "cc".repeat(32);
const GOOD_ITEM = {
  id: GOOD_ID, domain: "csd:test", title: "real title", body: "real body", links: [],
  proposer: "0x" + "11".repeat(20), payloadHash: "0xa77768fff59ae446e186d0851978be0098ecb93b947b81b88f261d0c82c79c08",
  source: "chain", totalWeight: 1, supporterCount: 1, avgScore: 9, createdTime: 0,
};
let tokenSeenAtRedirectTarget = false;
let staleMode = false; // R12: when on, the freshness surface reports a frozen tip
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const j = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
  if (u.pathname === "/__stale") { staleMode = u.searchParams.get("on") === "1"; return j({ ok: true, staleMode }); } // test control
  if (u.pathname === "/api/health") return j({ ok: true });
  if (u.pathname === "/api/board") return j({ items: [EVIL_ITEM] });
  if (u.pathname.startsWith("/api/item/")) return j({ ok: true, item: u.pathname.includes(GOOD_ID) ? GOOD_ITEM : EVIL_ITEM, supports: [{ attester: "0x" + "22".repeat(20), weight: 1 }], integrityOk: true });
  if (u.pathname === "/api/wall") return j({ totals: { stones: 1, boosts: 1 }, epoch: 1, king: { message: "king" + EVIL, weight: 1, boosts: 1 }, stones: [{ message: "stone" + EVIL, weight: 1, boosts: 1, ts: 0, tags: ["tag" + EVIL] }] });
  if (u.pathname === "/api/network") return j({ reachable: true, hashrateGHs: 1, hashrate1h: 1, hashrate24h: 1, height: 1, avgBlockTimeSecs: 120, targetBlockSecs: 120, minerCount: 1, peers: 1, knownPeers: 1, mempoolTxCount: 0, blockRewardCoins: 50, emittedSupplyCoins: 1, chainAgeDays: 1, proposals: 1, attestations: 1, transactions: 1 });
  if (u.pathname.startsWith("/api/profile/")) return j({ ok: true, profile: { handle: "h" + EVIL, bio: "b" + EVIL, github: "g" + EVIL, addr: "0x" + "11".repeat(20) }, reputation: { trust: 1 } });
  if (u.pathname === "/api/leaderboard") return j({ leaderboard: [{ handle: "lb" + EVIL, addr: "0x" + "11".repeat(20), trust: 1, shipped: 1, proposed: 1 }] });
  if (u.pathname === "/api/quests") return j({ quests: [{ id: "0x" + "cd".repeat(32), title: "q" + EVIL, status: "open" + EVIL, quest: {}, demandWeight: 0, demandSupporters: 0 }] });
  if (u.pathname === "/api/domains") return j({ domains: [{ key: "csd:test" + EVIL, title: "t" + EVIL, count: 1 }], discovered: [] });
  if (u.pathname === "/api/activity") return j({ activity: [{ type: "support", item: "it" + EVIL, time: 0, amount: 1 }] });
  if (u.pathname.startsWith("/api/rpc/utxos-all/")) {
    // the mock-wallet address gets a clean, spendable UTXO (so we reach the submit→confirm path);
    // every OTHER address gets the junk-txid UTXO (the malformed-input rejection test).
    const okUtxo = { txid: "0x" + "be".repeat(32), vout: 0, value: 9e9, confirmations: 10, coinbase: false };
    const junk = { txid: "not-a-real-txid;rm -rf", vout: 0, value: 9e9, confirmations: 10, coinbase: false };
    return j({ confirmed_balance: 9e9, utxos: [u.pathname.toLowerCase().includes(WALLET_ADDR.slice(2)) ? okUtxo : junk] });
  }
  // hostile submit: forge an "already present / conflict" error for a tx that is NOT really ours
  if (u.pathname === "/api/rpc/tx/submit") return j({ ok: false, err: "tx already present in mempool (conflict)" });
  // tx-status: the node confirms ONLY MINED_TXID as on-chain (the happy case); every other
  // txid — incl. the conflict case's TX_TXID — is "not found" (no proof), so an evidence-based
  // client must NOT believe the forged conflict string for those.
  if (u.pathname.startsWith("/api/rpc/tx/")) {
    const id = u.pathname.split("/").pop();
    return id && id.toLowerCase() === MINED_TXID.toLowerCase()
      ? j({ ok: true, txid: id, block_hash: "0x" + "bb".repeat(32), height: 2 })
      : j({ ok: false, txid: id, err: "not found" });
  }
  if (u.pathname.startsWith("/proposal/") || u.pathname.startsWith("/api/rpc/proposal/")) return j({ proposal: { payload_hash: u.pathname.includes(GOOD_ID) ? GOOD_ITEM.payloadHash : FORGED_HASH } });
  if (u.pathname === "/api/rpc/tip") return j({ height: 1 });
  // chain-view freshness surface (R12): FRESH by default; staleMode reports a frozen tip
  if (u.pathname === "/api/rpc/status") return j(staleMode
    ? { ok: true, stale: true, height: 1, secondsSinceAdvance: 9999, staleSecsThreshold: 600 }
    : { ok: true, stale: false, height: 1, secondsSinceAdvance: 5, staleSecsThreshold: 600 });
  // a write that the hostile server tries to 302 to an attacker host to capture the token
  if (u.pathname === "/api/propose") { res.statusCode = 302; res.setHeader("location", "http://127.0.0.1:1/steal"); return res.end(); }
  if (u.pathname === "/steal") { if (req.headers["x-cairn-token"]) tokenSeenAtRedirectTarget = true; return j({ ok: false }); }
  res.statusCode = 404; j({ ok: false });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${server.address().port}`;

// A SECOND reachable node-RPC on a DIFFERENT port of the SAME machine — to prove that a port
// difference alone no longer earns the "trustless/independent" wording (F11). Serves the GOOD
// item's matching chain proposal so verify reaches the independence branch.
const rpcServer = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("content-type", "application/json");
  if (u.pathname.startsWith("/proposal/")) return res.end(JSON.stringify({ proposal: { payload_hash: GOOD_ITEM.payloadHash } }));
  res.statusCode = 404; res.end(JSON.stringify({ ok: false }));
});
await new Promise((r) => rpcServer.listen(0, "127.0.0.1", r));
const RPC_DIFF_PORT = `http://127.0.0.1:${rpcServer.address().port}`; // same host, different port

console.log(`cairn-cli SECURITY suite vs hostile server ${API}\n`);

// sanity: confirm the hostile fields ACTUALLY reach the renderer (so the ANSI checks aren't
// vacuous) — the stripped output must still contain the attacker's literal "FAKE"/"pwned" text.
console.log("— harness sanity (hostile content really is rendered) —");
const lsSane = (await run(["ls", "all"], { CAIRN_API: API, CAIRN_COLOR: "1", NO_COLOR: "" })).out;
check("hostile item title actually reaches the CLI output", /FAKE|pwned|title/.test(lsSane.replace(/\x1b\[[0-9;]*m/g, "")));

console.log("\n— terminal-escape (ANSI/OSC) injection: no raw escapes reach the TTY —");
for (const [name, args] of [
  ["ls", ["ls", "all"]], ["show", ["show", EVIL_ITEM.id]], ["wall", ["wall"]],
  ["network", ["network"]], ["profile", ["profile", "0x" + "11".repeat(20)]],
  ["leaderboard", ["leaderboard"]], ["quests", ["quests"]], ["domains", ["domains"]], ["recent", ["recent"]],
]) {
  const out = (await run(args, { CAIRN_API: API, CAIRN_COLOR: "1", NO_COLOR: "" })).out
    .replace(/\x1b\[[0-9;]*m/g, ""); // strip the CLI's OWN legitimate SGR color codes
  check(`${name}: no ESC/BEL/CSI from hostile fields`, !hasESC(out));
}

console.log("\n— verify: forged item must NOT read 'trustless' when RPC host == API host —");
const vSame = (await run(["verify", EVIL_ITEM.id], { CAIRN_API: API, CAIRN_RPC: `${API}/api/rpc` })).out;
check("forged content → MISMATCH (recomputed ≠ forged reported hash)", /MISMATCH/.test(vSame));
check("never claims 'trustless' for a same-host RPC", !/trustless/i.test(vSame));

console.log("\n— hostile proxy: malformed txid is rejected (never reaches csd --input) —");
const sendOut = (await run(["send", "--to", "0x" + "cc".repeat(20), "--amount", "0.1"], { CAIRN_API: API })).out;
check("junk txid never echoed into output", !/not-a-real-txid|rm -rf/.test(sendOut));

console.log("\n— operator token never leaks to a redirect target (redirect: error) —");
await run(["propose", "--domain", "csd:test", "--title", "x", "--body", "y"], { CAIRN_API: API, CAIRN_TOKEN: "SECRET", CAIRN_CSD: "/nonexistent/csd" });
check("x-cairn-token NOT delivered to the 302 location", tokenSeenAtRedirectTarget === false);

// R17: a forged "already present / conflict" from the proxy must NOT be reported as success when
// the node has no proof of our exact txid on-chain. Drive the real csd→submit→confirm path with
// the mock csd; fast confirm budget so the 18s kill timer doesn't fire.
console.log("\n— R17: a conflict / forged 'already present' is NOT reported as success (evidence-based) —");
const CSDENV = { CAIRN_API: API, CAIRN_CSD: MOCK_CSD, CAIRN_ADDR: WALLET_ADDR, CAIRN_CONFIRM_ATTEMPTS: "2", CAIRN_CONFIRM_INTERVAL_MS: "50" };
const sendConf = (await run(["send", "--to", "0x" + "cc".repeat(20), "--amount", "0.1"], CSDENV)).out;
check("send: forged conflict (txid not on-chain) → reported as FAILURE, never 'sent'", /submit rejected|conflict|failed|not found/i.test(sendConf) && !/^\s*✔?\s*sent/m.test(sendConf.replace(/[✔✓●·]/g, "")) && !/\bsent\s+0x/i.test(sendConf));
const supConf = (await run(["support", "0x" + "ab".repeat(32), "--fee", "0.05"], CSDENV)).out;
check("support: forged conflict → reported as FAILURE, never 'supported'", !/\bsupported\s+0x/i.test(supConf));
// happy path: when the SAME conflict string comes back but the node DOES confirm our txid as
// mined, the evidence-based client correctly reports success (no false negatives).
const sendOk = (await run(["send", "--to", "0x" + "cc".repeat(20), "--amount", "0.1"], { ...CSDENV, CAIRN_CSD: MOCK_CSD_MINED })).out;
check("send: a node-confirmed txid IS reported as 'sent' (evidence accepted, no false negative)", /\bsent\s+0x/i.test(sendOk));

// UTXO-VALUE-1: a CSD fee is implicit (Σin − Σout) with NO chain max, so a hostile proxy that
// under-reports the input — or a fat-fingered --fee — silently burns the difference. The max-fee
// sanity guard must REFUSE an absurd fee BEFORE building/signing, with a --max-fee override.
console.log("\n— UTXO-VALUE-1: max-fee sanity guard refuses an absurd fee (silent fund-burn) —");
const SENDOK_ENV = { ...CSDENV, CAIRN_CSD: MOCK_CSD_MINED };
const bigFee = (await run(["send", "--to", "0x" + "cc".repeat(20), "--amount", "0.1", "--fee", "50"], SENDOK_ENV)).out;
check("send: an absurd --fee (50 CSD on a 0.1 send) is REFUSED, never 'sent'", /abnormally high/i.test(bigFee) && !/\bsent\s+0x/i.test(bigFee));
const bigFeeOver = (await run(["send", "--to", "0x" + "cc".repeat(20), "--amount", "0.1", "--fee", "50", "--max-fee", "60"], SENDOK_ENV)).out;
check("send: --max-fee override lets a deliberate high fee through (proceeds to 'sent')", /\bsent\s+0x/i.test(bigFeeOver));
const bigFeeDry = (await run(["send", "--to", "0x" + "cc".repeat(20), "--amount", "0.1", "--fee", "50", "--dry-run"], SENDOK_ENV)).out;
check("send --dry-run surfaces the abnormal-fee warning and does NOT send", /abnormally high/i.test(bigFeeDry) && /dry-run/i.test(bigFeeDry) && !/\bsent\s+0x/i.test(bigFeeDry));
const normalFee = (await run(["send", "--to", "0x" + "cc".repeat(20), "--amount", "0.1"], SENDOK_ENV)).out;
check("send: a normal default fee still passes the guard (no false positive)", /\bsent\s+0x/i.test(normalFee) && !/abnormally high/i.test(normalFee));

// R12: a STALE/frozen tip must fail-closed BEFORE any tx is built or signed.
console.log("\n— R12: a stale/frozen tip blocks tx building (fail-closed), --force-stale overrides —");
await fetch(`${API}/__stale?on=1`);
const stale = (await run(["send", "--to", "0x" + "cc".repeat(20), "--amount", "0.1"], CSDENV)).out;
check("send aborts on a stale tip (no 'sent', refuses to build)", /STALE/i.test(stale) && !/\bsent\s+0x/i.test(stale));
const forced = (await run(["send", "--to", "0x" + "cc".repeat(20), "--amount", "0.1", "--force-stale"], { ...CSDENV, CAIRN_CSD: MOCK_CSD_MINED })).out;
check("--force-stale overrides the stale gate (proceeds, warns)", /proceeding anyway|--force-stale/i.test(forced) && /\bsent\s+0x/i.test(forced));
await fetch(`${API}/__stale?on=0`);

// F13/R18: a tampered config.address must NOT silently redirect `cairn address` — the csd wallet
// is the source of truth, so a mismatch is flagged and the real wallet address is used.
console.log("\n— F13/R18: a tampered cached config.address can't redirect the address —");
const EVIL_ADDR = "0x" + "ee".repeat(20);
const cfgPath = join(tmp, "tampered.json");
writeFileSync(cfgPath, JSON.stringify({ address: EVIL_ADDR }));
const addrOut = (await run(["address"], { CAIRN_API: API, CAIRN_CSD: MOCK_CSD, CAIRN_ADDR: "", CAIRN_CLI_CONFIG: cfgPath })).out;
// the bare (non-TTY) address line that a funder would pipe must be the WALLET address — the
// tampered value may only appear inside the loud mismatch WARNING, never as the resolved address.
const bareLine = addrOut.trim().split("\n").map((l) => l.trim()).filter((l) => /^0x[0-9a-fA-F]{40}$/.test(l)).pop();
check("bare `address` resolves to the WALLET address, never the tampered config one", bareLine === WALLET_ADDR);
check("the mismatch is surfaced loudly (not silently swapped)", /does NOT match|tampered/i.test(addrOut));

// F11: a port difference does NOT make a same-machine RPC 'independent'. Use the WELL-FORMED
// item so the content+chain hashes MATCH and verify reaches the independence branch — then the
// only thing withholding "trustless" must be the same-machine (hostname) check, not a mismatch.
console.log("\n— F11: same-machine RPC (different port) is NOT 'trustless/independent' —");
// CAIRN_RPC is a reachable node on the SAME host (127.0.0.1) as CAIRN_API but a DIFFERENT port.
// Pre-fix this read "VERIFIED — trustless (independent CAIRN_RPC)"; the hostname-only compare fixes it.
const vPort = (await run(["verify", GOOD_ID], { CAIRN_API: API, CAIRN_RPC: RPC_DIFF_PORT })).out;
check("well-formed item verifies content (reaches the independence branch)", /matches/i.test(vPort) && !/MISMATCH/.test(vPort));
// the BAD outcome is the positive verdict "VERIFIED — … (trustless, via an independent CAIRN_RPC)";
// the advisory "point it at an independent node for a trustless check" is the CORRECT same-host text.
check("same host + different port never asserts the trustless verdict", !/VERIFIED/.test(vPort) && !/via an independent/i.test(vPort));
check("warns the RPC shares a host (so the user knows it's not a trustless check)", /shares a host/i.test(vPort));

console.log("\n— san() unit: strips control chars, keeps printable text —");
const { san } = await import("../dist/lib/ui.js");
const s = san("A\x1b[31m\x07B\x9bC\rD");
check("san removes ESC/BEL/C1/CR, keeps letters", !/[\x00-\x1f\x7f-\x9f]/.test(s) && s.includes("A") && s.includes("D"));

server.close();
rpcServer.close();
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
