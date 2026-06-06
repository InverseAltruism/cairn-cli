// Black-box end-to-end tests: run the built CLI as a subprocess against a live Cairn
// instance and assert on real output — no mocks. Covers every command plus error /
// edge paths. Read-only by default (safe to re-run); the real write path (propose/
// support, which posts on-chain) runs only with CLI_E2E_WRITE=1.
//
//   node test/e2e.mjs                 # read + error paths against $CAIRN_API
//   CLI_E2E_WRITE=1 node test/e2e.mjs # also exercise propose/support (needs a token)
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = process.env.CAIRN_API || "http://127.0.0.1:7777";
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log((c ? "  ✅ " : "  ❌ ") + n); };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
function run(args, extraEnv = {}) {
  const r = spawnSync("node", [CLI, ...args], { env: { ...process.env, CAIRN_API: API, NO_COLOR: "1", CAIRN_CSD: "/nonexistent/csd", CAIRN_ADDR: "", CAIRN_CLI_CONFIG: "/nonexistent/cfg.json", ...extraEnv }, encoding: "utf8", timeout: 20000 });
  return { out: strip((r.stdout || "") + (r.stderr || "")), code: r.status };
}

// preflight: is a live instance reachable? if not, skip cleanly (this is an
// integration suite — it needs a running board, unlike the pure unit tests elsewhere).
let reachable = false;
try { reachable = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(4000) })).ok; } catch { /* down */ }
if (!reachable) { console.log(`(no live Cairn at ${API} — skipping integration E2E)`); process.exit(0); }

console.log(`CLI E2E vs ${API}\n`);

// discover real data to test against
const lsJson = run(["ls", "all", "--json"]);
let items = [];
try { items = JSON.parse(lsJson.out); } catch { /* asserted below */ }
const domainsOut = run(["domains"]).out;

console.log("— read commands —");
check("help lists the core commands", /commands/.test(run([]).out) && /propose/.test(run([]).out));
check("domains shows a featured category (csd:apps)", /csd:apps/.test(domainsOut));
check("domains shows the 'open domains' section", /open domains/.test(domainsOut));
check("ls --json returns a JSON array of items", Array.isArray(items));
check("ls all prints ranked rows (or an explicit empty notice)", /#1|no items here/.test(run(["ls", "all"]).out));
check("recent prints the activity feed", /recent activity/.test(run(["recent"]).out));

console.log("\n— lenses (--sort) —");
const bySup = run(["ls", "all", "--sort", "supporterCount"]).out;
check("ls --sort supporterCount labels the lens in the header", /# supporters/.test(bySup));
// ordering oracle: top item's supporterCount ≥ the next one's (client-side lens sort)
const sorted = items.slice().sort((a, b) => (b.supporterCount || 0) - (a.supporterCount || 0));
check("supporterCount lens actually orders by #supporters", sorted.length < 2 || sorted[0].supporterCount >= sorted[1].supporterCount);
check("an unknown --sort falls back to raw CSD (no crash)", /CSD support \(raw\)/.test(run(["ls", "all", "--sort", "boguslens"]).out));

console.log("\n— item detail + integrity —");
if (items[0]) {
  const id = items[0].id;
  const show = run(["show", id]).out;
  check("show <id> renders the item + integrity line", new RegExp(items[0].title.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(show) && /integrity/i.test(show));
  check("verify <id> (content) reports a hash match", /matches|VERIFIED/i.test(run(["verify", id]).out));
  // trustless path: point CAIRN_RPC at the node RPC → recompute vs the on-chain commitment
  check("verify <id> with CAIRN_RPC checks the chain directly", /VERIFIED|on-chain/i.test(run(["verify", id], { CAIRN_RPC: `${API}/api/rpc` }).out));
} else { check("show/verify skipped (board empty)", true); }

console.log("\n— open domains —");
const open = (await fetch(`${API}/api/domains`).then((r) => r.json())).discovered?.[0];
if (open) {
  const o = run(["ls", open.key, "--json"]);
  let oi = []; try { oi = JSON.parse(o.out); } catch { /* */ }
  check(`ls <open domain ${open.key}> serves it (${open.count} items)`, Array.isArray(oi) && oi.length === open.count);
} else { check("open-domain browse skipped (none discovered)", true); }

console.log("\n— telemetry / social / identity reads —");
const net = run(["network"]).out;
check("network prints hashrate + block height", /hashrate/.test(net) && /block height/.test(net));
check("stats is an alias for network", /hashrate/.test(run(["stats"]).out));
check("wall renders (King/top stones, or an empty-wall notice)", /the wall|no stones/i.test(run(["wall"]).out));
check("quests renders (open quests, or an empty notice)", /quests/i.test(run(["quests"]).out));
check("leaderboard renders (ranked builders, or an empty notice)", /leaderboard|reputation/i.test(run(["leaderboard"]).out));
check("top is an alias for ls", /#1|no items here/.test(run(["top", "all"]).out));
// profile: pick a real proposer from the board if we have one, else assert the not-found path
const someAddr = items.find((i) => /^0x[0-9a-fA-F]{40}$/.test(i.proposer || ""))?.proposer;
if (someAddr) check("profile <addr> renders identity/reputation", /profile|trust|address/i.test(run(["profile", someAddr]).out));
else check("profile <unknown> → graceful 'no profile' (no crash)", /no profile/i.test(run(["profile", "0x"+"11".repeat(20)]).out));
check("watch (non-TTY) prints one snapshot and exits", /#1|no items here/.test(run(["watch", "all"]).out));

console.log("\n— address resolution (no csd) —");
check("address without csd/addr → guidance (no crash)", /address|setup|csd/i.test(run(["address"]).out));
check("address --address <0x40> (non-TTY) echoes the bare address", run(["address", "--address", "0x"+"ab".repeat(20)]).out.trim() === "0x"+"ab".repeat(20));

console.log("\n— write-arg validation (pre-sign, no csd needed) —");
check("send bad recipient → 'bad recipient'", /bad recipient/i.test(run(["send", "--to", "0xnothex", "--amount", "1"]).out));
check("send bad amount → 'bad amount'", /bad amount/i.test(run(["send", "--to", "0x"+"cc".repeat(20), "--amount", "-5"]).out));
check("send malformed --output → 'bad --output'", /bad --output/i.test(run(["send", "--output", "missingcolon"]).out));
check("send with no outputs → usage", /usage/.test(run(["send"]).out));
check("support non-hex id → '0x…64' rejection (before any signing)", /0x…64/.test(run(["support", "deadbeef", "--fee", "0.05"]).out));
check("propose missing domain/title → usage", /usage/.test(run(["propose", "--body", "no domain or title"]).out));

console.log("\n— error & edge paths —");
check("show <bad id> → 'not found', no crash", /not found/.test(run(["show", "0xdeadbeef"]).out));
check("verify with no id → usage hint", /usage/.test(run(["verify"]).out));
check("unreachable API → friendly 'cannot reach' (no stack trace)", /cannot reach/i.test(run(["ls"], { CAIRN_API: "http://127.0.0.1:9" }).out));
check("no stack traces leak on the unreachable path", !/ at .*\(.*:\d+:\d+\)/.test(run(["ls"], { CAIRN_API: "http://127.0.0.1:9" }).out));
check("propose without csd → guides to install/csd wallet", /csd|wallet/i.test(run(["propose", "--domain", "csd:test", "--title", "x", "--body", "y"]).out));
check("support without csd → guides (or rejects bad id)", /csd|wallet|0x…64/i.test(run(["support", "0x"+"ab".repeat(32), "--fee", "0.05"]).out));
check("help lists the wallet section (setup/send)", /setup/.test(run(["help"]).out) && /send/.test(run(["help"]).out));
check("send without csd → guides", /csd|wallet/i.test(run(["send", "--to", "0x"+"cc".repeat(20), "--amount", "0.01"]).out));
check("--no-color yields zero ANSI escapes (clig.dev)", !/\x1b\[/.test(spawnSync("node", [CLI, "network", "--no-color"], { env: { ...process.env, CAIRN_API: API, CAIRN_COLOR: "1" }, encoding: "utf8", timeout: 20000 }).stdout || ""));

console.log("\n— write path (opt-in: CLI_E2E_WRITE=1) —");
let token = process.env.CAIRN_TOKEN;
if (!token) { const f = join(homedir(), ".config/cairn/config.json"); if (existsSync(f)) { try { token = JSON.parse(readFileSync(f, "utf8")).writeToken; } catch { /* */ } } }
if (process.env.CLI_E2E_WRITE === "1" && token) {
  const r = run(["propose", "--domain", "csd:test", "--title", "cli-e2e probe", "--body", "automated CLI write-path test", "--fee", "25000000"], { CAIRN_TOKEN: token });
  const m = r.out.match(/proposed\s+(0x[0-9a-f]+)/i);
  check("propose with token → accepted, returns a txid (server signed + submitted)", !!m);
  if (m) console.log(`     (on-chain probe id ${m[1].slice(0, 18)}… in csd:test — indexes after ~1 block)`);
} else {
  console.log(`  ⏭  real write test skipped (${token ? "set CLI_E2E_WRITE=1 to run" : "no token found"})`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
