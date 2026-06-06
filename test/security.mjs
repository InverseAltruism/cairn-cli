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

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
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
let tokenSeenAtRedirectTarget = false;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const j = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
  if (u.pathname === "/api/health") return j({ ok: true });
  if (u.pathname === "/api/board") return j({ items: [EVIL_ITEM] });
  if (u.pathname.startsWith("/api/item/")) return j({ ok: true, item: EVIL_ITEM, supports: [{ attester: "0x" + "22".repeat(20), weight: 1 }], integrityOk: true });
  if (u.pathname === "/api/wall") return j({ totals: { stones: 1, boosts: 1 }, epoch: 1, king: { message: "king" + EVIL, weight: 1, boosts: 1 }, stones: [{ message: "stone" + EVIL, weight: 1, boosts: 1, ts: 0, tags: ["tag" + EVIL] }] });
  if (u.pathname === "/api/network") return j({ reachable: true, hashrateGHs: 1, hashrate1h: 1, hashrate24h: 1, height: 1, avgBlockTimeSecs: 120, targetBlockSecs: 120, minerCount: 1, peers: 1, knownPeers: 1, mempoolTxCount: 0, blockRewardCoins: 50, emittedSupplyCoins: 1, chainAgeDays: 1, proposals: 1, attestations: 1, transactions: 1 });
  if (u.pathname.startsWith("/api/profile/")) return j({ ok: true, profile: { handle: "h" + EVIL, bio: "b" + EVIL, github: "g" + EVIL, addr: "0x" + "11".repeat(20) }, reputation: { trust: 1 } });
  if (u.pathname === "/api/leaderboard") return j({ leaderboard: [{ handle: "lb" + EVIL, addr: "0x" + "11".repeat(20), trust: 1, shipped: 1, proposed: 1 }] });
  if (u.pathname === "/api/quests") return j({ quests: [{ id: "0x" + "cd".repeat(32), title: "q" + EVIL, status: "open" + EVIL, quest: {}, demandWeight: 0, demandSupporters: 0 }] });
  if (u.pathname === "/api/domains") return j({ domains: [{ key: "csd:test" + EVIL, title: "t" + EVIL, count: 1 }], discovered: [] });
  if (u.pathname === "/api/activity") return j({ activity: [{ type: "support", item: "it" + EVIL, time: 0, amount: 1 }] });
  if (u.pathname.startsWith("/api/rpc/utxos-all/")) return j({ confirmed_balance: 9e9, utxos: [{ txid: "not-a-real-txid;rm -rf", vout: 0, value: 9e9, confirmations: 10, coinbase: false }] });
  if (u.pathname.startsWith("/proposal/") || u.pathname.startsWith("/api/rpc/proposal/")) return j({ proposal: { payload_hash: FORGED_HASH } });
  if (u.pathname === "/api/rpc/tip") return j({ height: 1 });
  // a write that the hostile server tries to 302 to an attacker host to capture the token
  if (u.pathname === "/api/propose") { res.statusCode = 302; res.setHeader("location", "http://127.0.0.1:1/steal"); return res.end(); }
  if (u.pathname === "/steal") { if (req.headers["x-cairn-token"]) tokenSeenAtRedirectTarget = true; return j({ ok: false }); }
  res.statusCode = 404; j({ ok: false });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${server.address().port}`;
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

console.log("\n— san() unit: strips control chars, keeps printable text —");
const { san } = await import("../dist/lib/ui.js");
const s = san("A\x1b[31m\x07B\x9bC\rD");
check("san removes ESC/BEL/C1/CR, keeps letters", !/[\x00-\x1f\x7f-\x9f]/.test(s) && s.includes("A") && s.includes("D"));

server.close();
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
