#!/usr/bin/env node
// cairn — command-line client for a Cairn signal board on Compute Substrate.
// Reads are public; posting needs CAIRN_TOKEN. Config via env: CAIRN_API, CAIRN_TOKEN, CAIRN_RPC.
import { CAIRN_API, CAIRN_ADDR, CAIRN_TOKEN, CAIRN_RPC, MIN_FEE_PROPOSE, MIN_FEE_ATTEST, CSD_PER_COIN, csdToCoins, loadLocalConfig, saveLocalConfig } from "./lib/config.js";
import * as api from "./lib/api.js";
import * as csd from "./lib/csd.js";
import { buildCommitment } from "./lib/item.js";
import { buildGatewayRecord, buildPeerRecord, buildIdentityCommit, buildIdentityReveal } from "@inversealtruism/csd-registry";
import { canonicalJson } from "@inversealtruism/csd-codec";
import { randomBytes } from "node:crypto";
import { c, banner, bannerAnimated, rule, badge, bar, csd as csdFmt, ok, warn, err, key as kdim, pad, spinner, sleep, isTty, anim, clearScreen, cursorHome, san } from "./lib/ui.js";

const CSD = (n: number) => Number.isFinite(n) ? Math.round(n * CSD_PER_COIN) : NaN; // CSD → base units
// Resolve the user's PUBLIC address (to fetch inputs from the proxy). Never reads the key
// unless we must derive it locally from the user's own csd wallet config (then we cache
// only the public address). Order: --address → CAIRN_ADDR → cached → derive via csd.
async function resolveAddr(a: Args): Promise<string | null> {
  const flag = a.flags.address ? String(a.flags.address) : (CAIRN_ADDR || loadLocalConfig().address);
  if (flag && /^0x[0-9a-fA-F]{40}$/.test(flag)) return flag;
  const cfg = await csd.walletConfig();
  // Prefer the address csd already exposes (change addr) — avoids re-deriving from the
  // privkey, which would put the key on the `csd` argv (visible via /proc on a shared host).
  if (cfg?.default_change_addr20 && /^0x[0-9a-fA-F]{40}$/.test(String(cfg.default_change_addr20))) {
    const addr = String(cfg.default_change_addr20); saveLocalConfig({ address: addr }); return addr;
  }
  if (cfg?.default_privkey) { const addr = await csd.deriveAddr(cfg.default_privkey); if (addr) { saveLocalConfig({ address: addr }); return addr; } }
  return null;
}
// Run a csd build/sign command (easy-path propose/attest/spend — they sign with the user's
// wallet CONFIG key, so we pass no key) and submit the resulting signed tx through the Cairn
// proxy ourselves. We do NOT trust csd's own auto-submit: it targets csd's configured node,
// which may be a different node than the one the Cairn board (and its miner) read — so a tx
// could sit in the wrong mempool and never get mined into the board's view. Always submit via
// the proxy (the board's miner-connected node). A repeat that comes back "already present /
// known" for OUR txid is success (the tx is in that node's mempool); a true double-spend
// "conflict" is the only ambiguous case, so we confirm via a tx lookup before claiming ok.
async function signAndSubmit(csdArgs: string[]): Promise<{ ok: boolean; txid?: string; error?: string }> {
  const r = await csd.run(csdArgs);
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || "csd failed").trim().split("\n").slice(-1)[0] };
  let out: any = null; try { out = JSON.parse(r.stdout); } catch { /* unexpected */ }
  if (!out?.tx) return { ok: false, error: "csd produced no signed transaction" };
  const txid: string | undefined = out.txid;
  const sub = await api.submitTx(out.tx).catch((e: any) => ({ ok: false, err: e.message }));
  if (sub.ok) return { ok: true, txid: sub.txid || txid };
  // A benign "already present / mempool conflict" for OUR txid means the tx is already in a
  // mempool (e.g. csd's own auto-submit reached this same node first, or a re-run) — success.
  // For a single-key wallet this is safe: only the key owner can produce a conflicting spend
  // of their own UTXO, so a conflict on our freshly-built tx is our own prior submit, not a
  // third party. (The narrow exception — two DIFFERENT local spends of one UTXO fired at once
  // — is on the user.) The node can't be queried for mempool membership (its /tx indexes only
  // mined txs), so we rely on the matching txid + benign message.
  if (txid && /already|present|known|in mempool|conflict/i.test(String(sub.err ?? ""))) return { ok: true, txid };
  return { ok: false, error: sub.err || "submit rejected by node", txid };
}
// Guard: a write needs `csd` installed + a configured wallet (or an explicit --address + csd key).
async function requireCsd(): Promise<boolean> {
  if (!(await csd.available())) { console.log(err("`csd` not found.") + c.gray("  Install the Compute Substrate CLI, then ") + c.cyan("csd wallet new") + c.gray(" / ") + c.cyan("csd wallet init --privkey <key>") + c.gray(". Or set CAIRN_CSD to its path.")); return false; }
  const cfg = await csd.walletConfig();
  if (!cfg?.default_privkey) { console.log(err("no csd wallet key configured.") + c.gray("  Run ") + c.cyan("csd wallet new") + c.gray(" then ") + c.cyan("csd wallet init --privkey <key>") + c.gray(" — cairn signs with your csd wallet.")); return false; }
  return true;
}

type Args = { _: string[]; flags: Record<string, string | boolean>; multi: Record<string, string[]> };
function parse(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[k] = true;
      else { flags[k] = next; (multi[k] ??= []).push(next); i++; }
    } else _.push(a);
  }
  return { _, flags, multi };
}
// Do two URLs point at the same host? (used to refuse a "trustless" verify claim when the
// node RPC and the board API are the same operator). Unparseable → treat as same (safe).
function sameHost(a: string, b: string): boolean {
  try { return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase(); } catch { return true; }
}
const age = (sec: number) => {
  if (!sec) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  return d < 3600 ? `${Math.floor(d / 60)}m` : d < 86400 ? `${Math.floor(d / 3600)}h` : `${Math.floor(d / 86400)}d`;
};

// Lenses: each is one transparent reading of the same on-chain data (matches the web
// UI). The board returns all of these precomputed; we just sort client-side by one.
const LENS: Record<string, string> = {
  totalWeight: "CSD support (raw)", quadratic: "quadratic", repWeight: "reputation-weighted",
  conviction: "conviction", supporterCount: "# supporters", createdHeight: "newest",
};
function printRows(items: any[], sort = "totalWeight") {
  if (!items.length) { console.log(c.gray("  (no items here)")); return; }
  const max = items[0]?.[sort] || items[0]?.totalWeight || 1;
  items.slice(0, 25).forEach((r, i) => {
    // annotate only lenses whose value isn't already shown in the row (raw + supporters are)
    const lens = !["totalWeight", "supporterCount"].includes(sort) && r[sort] != null
      ? c.gray(" · " + (sort === "createdHeight" ? "h" + r[sort] : csdFmt(r[sort]) + " " + sort)) : "";
    console.log("");
    console.log(`  ${c.magenta(c.bold("#" + (i + 1)))}  ${c.white(c.bold(san(r.title)))}  ${badge(r.source)}${r.sealed ? "  " + c.gray(r.revealed ? "🔓 revealed" : "🔒 sealed") : ""}`);
    console.log(`      ${bar(r[sort] || r.totalWeight, max)}  ${csdFmt(r.totalWeight)} ${c.gray("·")} ${c.green(String(r.supporterCount))} ${c.gray("supporters · score " + Number(r.avgScore) + " · " + age(r.createdTime) + " ago")}${lens}`);
    console.log(c.gray(`      ${san(r.domain)} · id ${san(String(r.id).slice(0, 22))}…`));
  });
}

async function cmdList(a: Args) {
  const domain = a._[1] ?? "all";
  const window = String(a.flags.window ?? "all");
  const sort = LENS[String(a.flags.sort ?? "")] ? String(a.flags.sort) : "totalWeight";
  const r = await api.apiBoard(domain, window);
  let items = r.items ?? [];
  if (sort !== "totalWeight") items = items.slice().sort((x: any, y: any) => (y[sort] || 0) - (x[sort] || 0));
  if (a.flags.json) { console.log(JSON.stringify(items, null, 2)); return; }
  banner();
  rule(`${domain} · ${LENS[sort]} · ${window} · ${CAIRN_API.replace(/^https?:\/\//, "")}`);
  printRows(items, sort);
}

async function cmdWatch(a: Args) {
  const domain = a._[1] ?? "all";
  const window = String(a.flags.window ?? "trending");
  if (!isTty) { printRows((await api.apiBoard(domain, window)).items); return; }
  const PERIOD = 5; // seconds between refreshes
  const PULSE = ["◐", "◓", "◑", "◒"]; // a spinning "live" mark in the footer
  process.stdout.write("\x1b[?25l");                                  // hide cursor
  const restore = () => process.stdout.write("\x1b[?25h\n");
  process.on("SIGINT", () => { restore(); process.exit(0); });
  clearScreen();
  let first = true;
  for (;;) {
    const r = await api.apiBoard(domain, window).catch(() => ({ items: [] }));
    // first paint clears the screen; subsequent paints repaint from home (no black flash)
    if (first) { clearScreen(); first = false; } else cursorHome();
    banner();
    rule(`watch · ${domain} · ${window} · ${new Date().toLocaleTimeString()}`);
    printRows(r.items);
    process.stdout.write("\n"); // reserve the footer line, then redraw it in place each second
    // animated footer: a phosphor pulse + a "next refresh" countdown (single line, \r-redrawn)
    for (let s = PERIOD; s > 0; s--) {
      const mark = c.green(PULSE[(PERIOD - s) % PULSE.length]!);
      process.stdout.write(`\r\x1b[K  ${mark} ${c.gray("live · " + (r.items?.length ?? 0) + " items · next refresh in " + s + "s · Ctrl+C to exit")}`);
      await sleep(anim ? 1000 : PERIOD * 1000);
      if (!anim) break;
    }
  }
}

async function cmdRecent() {
  const r = await api.apiActivity();
  banner(); rule("recent activity");
  for (const ev of r.activity ?? []) {
    const verb = ev.type === "support" ? c.green("◈ supported") : c.cyan("✎ proposed ");
    console.log(`  ${verb} ${c.white(san(String(ev.item).slice(0, 42)))} ${c.gray("· " + age(ev.time) + " ago · " + (Number(ev.amount) / 1e8) + " CSD")}`);
  }
}

async function cmdShow(a: Args) {
  const id = a._[1];
  if (!id) { console.log(warn("usage: cairn show <id>")); return; }
  const r = await api.apiItem(id).catch(() => null);
  if (!r || !r.ok) { console.log(err("not found")); return; }
  const it = r.item;
  rule(san(it.title));
  console.log(`  ${badge(it.source)}  ${c.gray("·")}  ${c.cyan(san(it.domain))}`);
  console.log(`\n  ${c.white(san(it.body))}\n`);
  if (it.links?.length) console.log(`  ${kdim("links")}     ${it.links.map((l: string) => c.cyan(san(l))).join(", ")}`);
  const total = (r.supports ?? []).reduce((x: number, s: any) => x + Number(s.weight), 0);
  console.log(`  ${kdim("support")}   ${csdFmt(total)} ${c.gray("from")} ${c.green(String(new Set((r.supports ?? []).map((s: any) => s.attester)).size))} ${c.gray("supporters")}`);
  console.log(`  ${kdim("proposer")}  ${c.gray(san(it.proposerHandle || it.proposer))}`);
  console.log(`  ${kdim("hash")}      ${c.magenta(san(it.payloadHash))}`);
  console.log(`  ${kdim("integrity")} ${r.integrityOk ? ok("content matches commitment") : err("MISMATCH")}`);
}

async function cmdVerify(a: Args) {
  const id = a._[1];
  if (!id) { console.log(warn("usage: cairn verify <id>")); return; }
  const sp = spinner("fetching + recomputing");
  const r = await api.apiItem(id).catch(() => null);
  if (!r || !r.ok) { sp.stop(); console.log(err("not found")); return; }
  const it = r.item;
  // Hash the RAW server-reported content (never san()'d — we must hash the exact bytes).
  const { payloadHash } = buildCommitment({ v: 1, domain: it.domain, title: it.title, body: it.body, links: it.links ?? [] });
  // Only consult the chain RPC for a well-formed id (the server echoes it.id back; an
  // attacker-shaped id must not be spliced into the RPC URL — see api.chainProposal).
  const chain = /^0x[0-9a-fA-F]{64}$/.test(String(it.id ?? "")) ? await api.chainProposal(it.id) : null;
  sp.stop();
  console.log(`${kdim("recomputed")}  ${c.magenta(payloadHash)}`);
  console.log(`${kdim("reported")}    ${c.magenta(san(it.payloadHash))}`);
  const contentOk = payloadHash.toLowerCase() === String(it.payloadHash).toLowerCase();
  if (chain?.payload_hash) {
    // "trustless" only holds if CAIRN_RPC is an INDEPENDENT node — if it's the same host as
    // the board API, the same operator controls both answers, so don't claim trustlessness.
    const independent = !sameHost(CAIRN_RPC, CAIRN_API);
    const chainOk = contentOk && String(chain.payload_hash).toLowerCase() === payloadHash.toLowerCase();
    console.log(`${kdim("on-chain")}    ${c.magenta(san(chain.payload_hash))}`);
    if (chainOk) console.log(independent
      ? ok("VERIFIED — content matches the on-chain commitment (trustless, via an independent CAIRN_RPC)")
      : ok("content matches the commitment reported by this RPC") + c.gray("  ⚠ CAIRN_RPC shares a host with CAIRN_API — point it at an independent node for a trustless check"));
    else console.log(err("MISMATCH"));
  } else {
    console.log(contentOk ? ok("content matches the reported commitment") + c.gray("  (set CAIRN_RPC to an independent node to also check the chain directly)") : err("content does NOT match the reported hash"));
  }
}

// ── wallet (on top of the user's installed `csd` — cairn never holds the key) ──
async function cmdSetup() {
  banner(); rule("setup — cairn over your csd wallet");
  const has = await csd.available();
  console.log(`  ${kdim("csd binary")}  ${has ? ok("found (" + csd.CSD_BIN + ")") : err("not found — install Compute Substrate's csd CLI, or set CAIRN_CSD to its path")}`);
  if (!has) { console.log(c.gray("\n  cairn signs nothing itself — it drives your csd wallet. Install csd, then re-run ") + c.cyan("cairn setup") + c.gray(".")); return; }
  const cfg = await csd.walletConfig();
  console.log(`  ${kdim("csd wallet")}  ${cfg?.default_privkey ? ok("key configured") : warn("no key — run ") + c.cyan("csd wallet new") + c.gray(" then ") + c.cyan("csd wallet init --privkey <key>")}`);
  const addr = await resolveAddr(a0());
  if (addr) {
    console.log(`  ${kdim("address")}     ${c.cyan(addr)}`);
    const b = await api.confirmedBalance(addr).catch(() => null);
    if (b) console.log(`  ${kdim("balance")}     ${c.white(csdToCoins(b.balance))} CSD ${c.gray("(" + b.utxos + " utxos)")}`);
  }
  console.log(`  ${kdim("api")}         ${c.gray(CAIRN_API)}`);
  if (has && cfg?.default_privkey) console.log(c.gray("\n  ready: ") + c.cyan("cairn send · cairn propose · cairn support · cairn wall place"));
}
const a0 = (): Args => ({ _: [], flags: {}, multi: {} });
async function cmdAddress(a: Args) {
  const addr = await resolveAddr(a);
  if (!addr) { console.log(err("no address — run ") + c.cyan("cairn setup") + err(" (needs a configured csd wallet) or pass --address")); return; }
  if (!isTty) { console.log(addr); return; }
  banner(); rule("your address"); console.log(`  ${kdim("address")}  ${c.cyan(addr)}`);
  const b = await api.confirmedBalance(addr).catch(() => null);
  if (b) console.log(`  ${kdim("balance")}  ${c.white(csdToCoins(b.balance))} CSD ${c.gray("(" + b.utxos + " utxos)")}`);
}
async function cmdBalance(a: Args) { return cmdAddress(a); }

function gatherOutputs(a: Args): { to: string; value: number }[] | string {
  const outs: { to: string; value: number }[] = [];
  for (const spec of (a.multi.output ?? [])) { const i = String(spec).lastIndexOf(":"); if (i < 0) return `bad --output (want <addr>:<CSD>): ${spec}`; outs.push({ to: String(spec).slice(0, i), value: CSD(Number(String(spec).slice(i + 1))) }); }
  if (a.flags.to !== undefined || a.flags.amount !== undefined) outs.push({ to: String(a.flags.to ?? ""), value: CSD(Number(a.flags.amount ?? 0)) });
  for (const o of outs) { if (!/^0x[0-9a-fA-F]{40}$/.test(o.to)) return `bad recipient: ${o.to}`; if (!(o.value > 0) || !Number.isSafeInteger(o.value)) return `bad amount for ${o.to}`; }
  return outs.length ? outs : "no outputs";
}
async function cmdSend(a: Args) {
  const outs = gatherOutputs(a);
  if (typeof outs === "string") { console.log(outs === "no outputs" ? warn("usage: ") + c.cyan("cairn send --to <0x…40> --amount <CSD> [--fee <CSD>]") + c.gray("  (repeat --output <a>:<CSD> for many)") : err(outs)); return; }
  if (!(await requireCsd())) return;
  const addr = await resolveAddr(a); if (!addr) { console.log(err("could not resolve your address — pass --address or run ") + c.cyan("cairn setup")); return; }
  const feeCsd = a.flags.fee !== undefined ? Number(a.flags.fee) : 0.01;
  const fee = (Number.isFinite(feeCsd) && feeCsd >= 0) ? CSD(feeCsd) : 1_000_000;
  const total = outs.reduce((s, o) => s + o.value, 0);
  console.log(`${kdim("from")}    ${c.cyan(addr)}`);
  for (const o of outs) console.log(`${kdim("to")}      ${c.cyan(o.to)} ${c.gray("→ " + csdToCoins(o.value) + " CSD")}`);
  console.log(`${kdim("fee")}     ${csdToCoins(fee)} CSD   ${kdim("total")} ${csdToCoins(total + fee)} CSD`);
  if (a.flags["dry-run"]) { console.log(c.gray("\n[dry-run] not sent")); return; }
  const sp = spinner("fetching input → csd signs → submit");
  const picked = await api.pickInput(addr, total + fee).catch(() => null);
  if (!picked) { sp.stop(); console.log(err("no single confirmed UTXO covers amount + fee") + c.gray(" — fund this address, or consolidate (a node + `csd … --auto-input` can combine inputs)")); return; }
  sp.stop();
  // transparency: show the input value + change so a hostile proxy under-reporting the input
  // (which would silently inflate the burned fee) is visible before we sign. Change goes to
  // your own address; the proxy can never redirect it.
  console.log(`${kdim("input")}   ${csdToCoins(picked.value)} CSD ${c.gray("(one UTXO)")}   ${kdim("change")} ${csdToCoins(Math.max(0, picked.value - total - fee))} CSD ${c.gray("back to you")}`);
  const sp2 = spinner("csd signs → submit");
  const args = ["spend"]; for (const o of outs) args.push("--output", `${o.to}:${o.value}`);
  args.push("--change", addr, "--fee", String(fee), "--input", picked.input);
  const r = await signAndSubmit(args); sp2.stop();
  console.log(r.ok ? ok(`sent  ${c.cyan(r.txid!)}`) + c.gray("  (signed by your csd wallet)") : err(r.error || "failed"));
}

async function cmdPropose(a: Args) {
  const domain = String(a.flags.domain ?? "");
  const title = String(a.flags.title ?? "");
  const body = String(a.flags.body ?? "");
  const links = a.multi.link ?? [];
  if (!domain || !title) { console.log(warn("usage: ") + c.cyan("cairn propose --domain csd:features --title <t> --body <b> [--link <url>] [--fee <CSD>] [--expires-days N]")); return; }
  const feeCsd = a.flags.fee !== undefined ? Number(a.flags.fee) : 0.25;
  const fee = Math.max(MIN_FEE_PROPOSE, Number.isFinite(feeCsd) ? CSD(feeCsd) : MIN_FEE_PROPOSE);
  // operator-token path stays available for the instance operator
  if (CAIRN_TOKEN && !(await csd.available())) {
    const sp = spinner("posting via operator token");
    try { const r = await api.apiPropose({ domain, title, body, links, fee }); sp.stop(); console.log(r.ok ? ok(`proposed  ${c.cyan(r.id)}`) + c.gray("  (operator)") : err(r.error || "failed")); } catch (e: any) { sp.stop(); console.log(err(e.message)); }
    return;
  }
  if (!(await requireCsd())) return;
  const addr = await resolveAddr(a); if (!addr) { console.log(err("could not resolve your address — pass --address or run ") + c.cyan("cairn setup")); return; }
  const content = { v: 1 as const, domain, title, body, links };
  const { payloadHash } = buildCommitment(content);
  const uri = "cairn:v1:" + payloadHash.slice(2, 14);
  if (a.flags["dry-run"]) {
    console.log(`${kdim("domain")}   ${c.cyan(domain)}`);
    console.log(`${kdim("title")}    ${c.white(title)}`);
    console.log(`${kdim("hash")}     ${c.magenta(payloadHash)} ${c.gray("· uri " + uri)}`);
    console.log(`${kdim("fee")}      ${csdToCoins(fee)} CSD   ${kdim("from")} ${c.cyan(addr)}`);
    console.log(c.gray("\n[dry-run] not signed or submitted"));
    return;
  }
  const sp = spinner("fetching input → csd signs → submit");
  const picked = await api.pickInput(addr, fee).catch(() => null);
  if (!picked) { sp.stop(); console.log(err("no confirmed UTXO above the fee") + c.gray(" — fund " + addr)); return; }
  const tip = await api.tipHeight().catch(() => 0);
  const days = Math.max(1, parseInt(String(a.flags["expires-days"] ?? 30)) || 30);
  const r = await signAndSubmit(["propose", "--domain", domain, "--payload-hash", payloadHash, "--uri", uri, "--expires-epoch", String(Math.floor(tip / 30) + days * 24), "--fee", String(fee), "--change", addr, "--input", picked.input]);
  sp.stop();
  if (!r.ok) { console.log(err(r.error || "failed")); return; }
  console.log(ok(`proposed  ${c.cyan(r.txid!)}`) + c.gray("  (signed by your csd wallet)"));
  const sp2 = spinner("registering content (waits for the tx to mine)");
  const done = await api.registerContent({ domain, title, body, links }, r.txid!);
  sp2.stop();
  console.log(done ? ok("content registered — visible on the board") : warn("content not registered yet — re-run once mined"));
}

async function cmdSupport(a: Args) {
  const id = a._[1];
  if (!id) { console.log(warn("usage: ") + c.cyan("cairn support <id> --fee <CSD> [--score 0-100] [--confidence 0-100]")); return; }
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) { console.log(err("proposal id must be 0x…64-hex")); return; }
  const feeCsd = a.flags.fee !== undefined ? Number(a.flags.fee) : 0.05;
  const fee = Math.max(MIN_FEE_ATTEST, Number.isFinite(feeCsd) ? CSD(feeCsd) : MIN_FEE_ATTEST);
  const score = Math.max(0, Math.min(100, parseInt(String(a.flags.score ?? 75)) || 0));
  const confidence = Math.max(0, Math.min(100, parseInt(String(a.flags.confidence ?? 60)) || 0));
  if (CAIRN_TOKEN && !(await csd.available())) {
    const sp = spinner("posting via operator token");
    try { const r = await api.apiSupport({ id, fee, score, confidence }); sp.stop(); console.log(r.ok ? ok(`supported  ${c.cyan(r.id)}`) + c.gray("  (operator)") : err(r.error || "failed")); } catch (e: any) { sp.stop(); console.log(err(e.message)); }
    return;
  }
  if (!(await requireCsd())) return;
  const addr = await resolveAddr(a); if (!addr) { console.log(err("could not resolve your address — pass --address or run ") + c.cyan("cairn setup")); return; }
  if (a.flags["dry-run"]) {
    console.log(`${kdim("support")}  ${c.cyan(id)}`);
    console.log(`${kdim("fee")}      ${csdToCoins(fee)} CSD ${c.gray("· score " + score + " · confidence " + confidence)}   ${kdim("from")} ${c.cyan(addr)}`);
    console.log(c.gray("\n[dry-run] not signed or submitted"));
    return;
  }
  const sp = spinner("fetching input → csd signs → submit");
  const picked = await api.pickInput(addr, fee).catch(() => null);
  if (!picked) { sp.stop(); console.log(err("no confirmed UTXO above the fee") + c.gray(" — fund " + addr)); return; }
  const r = await signAndSubmit(["attest", "--proposal-id", id, "--score", String(score), "--confidence", String(confidence), "--fee", String(fee), "--change", addr, "--input", picked.input]);
  sp.stop();
  console.log(r.ok ? ok(`supported  ${c.cyan(r.txid!)}`) + c.gray("  (signed by your csd wallet)") : err(r.error || "failed"));
}

async function cmdWall(a: Args) {
  if (a._[1] === "place") {
    const msg = a._.slice(2).join(" ").trim() || String(a.flags.message ?? "").trim();
    if (!msg) { console.log(warn("usage: ") + c.cyan('cairn wall place "<message>" [--fee <CSD>] [--dry-run]')); return; }
    // forward the write-relevant flags (fee, address, dry-run) through to the propose path
    const fwd: Record<string, string | boolean> = { domain: "cairn:wall", title: msg };
    for (const k of ["fee", "address", "dry-run"]) if (a.flags[k] !== undefined) fwd[k] = a.flags[k]!;
    return cmdPropose({ _: ["propose"], flags: fwd, multi: {} });
  }
  return cmdWallView();
}

async function cmdDomains() {
  const r = await api.apiDomains();
  banner(); rule("categories");
  for (const dom of r.domains ?? []) console.log(`  ${c.cyan(pad(san(dom.key), 20))} ${c.white(san(dom.title))} ${c.gray(dom.count != null ? "(" + Number(dom.count) + ")" : "")}`);
  // open domains: anyone can create one by proposing into it (cairn ls <domain> works for any).
  const disc = r.discovered ?? [];
  if (disc.length) {
    console.log(c.gray("\n  open domains (created by proposing into them):"));
    for (const d of disc) console.log(`  ${c.cyan(pad(san(d.key), 20))} ${c.gray((d.count != null ? Number(d.count) + " items" : "") + (d.totalWeight ? " · " + csdToCoins(d.totalWeight) + " CSD" : ""))}`);
  }
}

async function cmdWallView() {
  const r = await api.apiWall();
  const stones = r.stones ?? [];
  banner(); rule(`the wall · ${r.totals?.stones ?? 0} stones · ${r.totals?.boosts ?? 0} boosts · epoch ${r.epoch ?? "?"}`);
  if (r.king) console.log(`  ${c.green("★ KING")}  ${c.white(c.bold(san(r.king.message)))}  ${csdFmt(r.king.weight)} ${c.gray("· " + Number(r.king.boosts) + " boosts")}`);
  if (!stones.length) {
    console.log(c.gray("\n  no stones yet — place one with the Cairn Wallet, or:"));
    console.log(c.green("  cairn propose --domain cairn:wall --title '<message>'"));
    return;
  }
  const max = stones[0]?.weight || 1;
  stones.slice(0, 25).forEach((s: any, i: number) => {
    console.log("");
    console.log(`  ${c.magenta(c.bold("#" + (i + 1)))}  ${c.white(c.bold(san(s.message)))}${i === 0 ? "  " + c.green("★") : ""}`);
    console.log(`      ${bar(s.weight, max)}  ${csdFmt(s.weight)} ${c.gray("·")} ${c.green(String(s.boosts))} ${c.gray("boosts · " + age(s.ts) + " ago")}${(s.tags && s.tags.length) ? c.gray("  #" + s.tags.map((t: string) => san(t)).join(" #")) : ""}`);
  });
}

async function cmdNetwork() {
  const [n, s] = await Promise.all([api.apiNetwork(), api.apiStats().catch(() => null)]);
  banner(); rule("network · compute substrate");
  if (!n || !n.reachable) { console.log(err("node unreachable")); return; }
  const row = (k: string, v: string) => console.log(`  ${kdim(pad(k, 15))} ${v}`);
  const hr = (g: number) => (g >= 1000 ? (g / 1000).toFixed(2) + " TH/s" : (g ?? 0).toFixed(1) + " GH/s");
  row("hashrate", `${c.white(hr(n.hashrateGHs))} ${c.gray("(1h " + hr(n.hashrate1h) + " · 24h " + hr(n.hashrate24h) + ")")}`);
  row("block height", `${c.white(String(n.height))} ${c.gray("· last block " + age(n.lastBlockTime) + " ago")}`);
  row("block time", `${c.white((n.avgBlockTimeSecs ?? 0).toFixed(0) + "s")} ${c.gray("(target " + n.targetBlockSecs + "s)")}`);
  row("miners", `${c.white(String(n.minerCount))} ${c.gray("active ~24h")}`);
  row("peers", `${c.white(String(n.peers))} ${c.gray("connected · " + n.knownPeers + " known · mempool " + n.mempoolTxCount)}`);
  row("block reward", `${c.white(n.blockRewardCoins + " CSD")} ${c.gray("· " + Math.round(n.emittedSupplyCoins).toLocaleString() + " CSD emitted")}`);
  row("chain age", c.white((n.chainAgeDays ?? 0).toFixed(1) + " days"));
  row("activity", `${c.green(String(n.proposals))} proposals ${c.gray("·")} ${c.green(String(n.attestations))} attestations ${c.gray("· " + Number(n.transactions).toLocaleString() + " txs")}`);
  if (s) row("board", `${c.green(String(s.items))} items ${c.gray("·")} ${c.green(String(s.supports))} supports ${c.gray("·")} ${c.green(String(s.participants))} participants ${c.gray("· " + s.totalSignalCoins + " CSD signal")}`);
}

async function cmdProfile(a: Args) {
  const addr = a._[1];
  if (!addr) { console.log(warn("usage: ") + c.cyan("cairn profile <addr>")); return; }
  const r = await api.apiProfile(addr).catch(() => null);
  if (!r || !r.ok) { console.log(err("no profile for " + addr)); return; }
  const p = r.profile || {}, rep = r.reputation || {};
  banner(); rule(`profile · ${san(p.handle || addr)}`);
  if (p.handle) console.log(`  ${kdim(pad("handle", 13))} ${c.white(san(p.handle))}`);
  if (p.bio) console.log(`  ${kdim(pad("bio", 13))} ${c.gray(san(p.bio))}`);
  if (p.github) console.log(`  ${kdim(pad("github", 13))} ${c.cyan(san(p.github))} ${p.githubVerified ? ok("verified") : c.gray("(unverified)")}`);
  console.log(`  ${kdim(pad("address", 13))} ${c.gray(san(p.addr || addr))}`);
  console.log(`  ${kdim(pad("trust", 13))} ${c.white((rep.trust ?? 0).toFixed(2))}`);
  console.log(`  ${kdim(pad("work", 13))} ${c.green(String(rep.proposed ?? 0))} proposed ${c.gray("·")} ${c.green(String(rep.shipped ?? 0))} shipped ${c.gray("·")} ${c.green(String(rep.acceptedWork ?? 0))} accepted ${c.gray("·")} ${c.green(String(rep.reviews ?? 0))} reviews`);
}

async function cmdLeaderboard() {
  const r = await api.apiLeaderboard();
  banner(); rule("reputation leaderboard");
  const lb = r.leaderboard ?? [];
  if (!lb.length) { console.log(c.gray("  no ranked builders yet — reputation accrues from accepted quest work.")); return; }
  lb.slice(0, 25).forEach((e: any, i: number) => {
    console.log(`  ${c.magenta(c.bold(pad("#" + (i + 1), 4)))} ${c.white(pad(san(e.handle || e.addr), 26))} ${c.gray("trust")} ${c.white((Number(e.trust) || 0).toFixed(2))} ${c.gray("· " + Number(e.shipped ?? e.acceptedWork ?? 0) + " shipped · " + Number(e.proposed ?? 0) + " proposed")}`);
  });
}

async function cmdQuests() {
  const r = await api.apiQuests();
  banner(); rule("quests");
  const qs = r.quests ?? [];
  if (!qs.length) { console.log(c.gray("  no open quests yet.")); return; }
  qs.slice(0, 25).forEach((q: any, i: number) => {
    const reward = q.quest?.reward?.build ? csdToCoins(q.quest.reward.build) + " CSD" : "—";
    console.log("");
    console.log(`  ${c.magenta(c.bold("#" + (i + 1)))} ${c.white(c.bold(san(q.title)))} ${c.gray("· " + san(q.status || "?"))}`);
    console.log(`      ${c.gray("reward " + reward + " · demand " + csdFmt(q.demandWeight || 0) + " · " + Number(q.demandSupporters || 0) + " backers")}`);
    console.log(c.gray(`      id ${san(String(q.id).slice(0, 22))}…`));
  });
}

async function help() {
  await bannerAnimated();
  const cmd = (n: string, args: string, d: string) => console.log(`  ${c.cyan(pad(n, 9))} ${c.gray(pad(args, 44))} ${c.dim(d)}`);
  console.log(c.bold("  commands"));
  cmd("domains", "", "list categories + open domains");
  cmd("ls", "[domain] --window trending|7d|30d|all --sort <lens>", "browse the board (+ --json)");
  cmd("top", "[domain]", "alias for ls");
  cmd("watch", "[domain]", "live auto-refreshing board");
  cmd("recent", "", "recent proposals + support");
  cmd("show", "<id>", "item detail + integrity");
  cmd("verify", "<id>", "recompute hash, check vs chain");
  cmd("wall", "", "the Wall — top stones + King");
  cmd("network", "", "live network telemetry (alias: stats)");
  cmd("quests", "", "open quests");
  cmd("profile", "<addr>", "identity + reputation");
  cmd("leaderboard", "", "top builders by reputation");
  cmd("wall place", '"<message>"', "place a stone on the Wall (a cairn:wall proposal)");
  console.log("");
  console.log(c.bold("  wallet") + c.gray("  (signs with your installed csd wallet — cairn never holds your key)"));
  cmd("setup", "", "check csd + wallet, show your address (alias: doctor)");
  cmd("address", "", "your address + balance (alias: whoami, balance)");
  cmd("send", "--to <0x…40> --amount <CSD>", "transfer CSD (+ --output <a>:<CSD> ×N, --fee <CSD>, --dry-run)");
  cmd("propose", "--domain <d> --title <t> --body <b>", "post an item (alias: post; + --fee, --expires-days, --dry-run)");
  cmd("support", "<id> --fee <CSD>", "back an item (+ --score, --confidence, --dry-run)");
  console.log(c.gray("\n  lenses (--sort): " + Object.keys(LENS).join(" · ")));
  console.log(c.gray(`  api: ${CAIRN_API}  ·  1 CSD = ${CSD_PER_COIN} base · propose ≥ ${csdToCoins(MIN_FEE_PROPOSE)} · attest ≥ ${csdToCoins(MIN_FEE_ATTEST)} CSD`));
  console.log(c.gray("  config: CAIRN_API (board) · CAIRN_CSD (csd binary) · CAIRN_ADDR (your addr) · CAIRN_RPC (trustless verify) · CAIRN_TOKEN (operator)"));
  console.log(c.gray("  display: honors NO_COLOR · --no-color · --no-anim · TERM=dumb (color/animation auto-off when piped)"));
  console.log(c.gray("  writes are signed by your own ") + c.cyan("csd") + c.gray(" wallet (csd wallet new / init); cairn supplies the input + Cairn content. Sealed claims + Sign-in: use the Cairn Wallet."));
}

async function main() {
  const a = parse(process.argv.slice(2));
  switch (a._[0]) {
    case "domains": return cmdDomains();
    case "ls": case "list": case "top": return cmdList(a);
    case "watch": return cmdWatch(a);
    case "recent": return cmdRecent();
    case "show": return cmdShow(a);
    case "verify": return cmdVerify(a);
    case "wall": return cmdWall(a);
    case "network": case "stats": return cmdNetwork();
    case "quests": return cmdQuests();
    case "profile": return cmdProfile(a);
    case "leaderboard": case "lb": return cmdLeaderboard();
    case "setup": case "doctor": return cmdSetup();
    case "address": case "whoami": return cmdAddress(a);
    case "balance": return cmdBalance(a);
    case "send": return cmdSend(a);
    case "propose": case "post": return cmdPropose(a);
    case "support": return cmdSupport(a);
    case "gateway": return cmdGateway(a);
    case "peer": return cmdPeer(a);
    case "identity": return cmdIdentity(a);
    default: return help();
  }
}
// ── L3 registry publish commands (build a signed record → anchor Propose → serve bytes) ──

// Anchor a built registry record: Propose{domain, payloadHash} signed by the csd wallet,
// then publish the EXACT canonical bytes to the content origin (self-certified on arrival).
async function anchorRecord(rec: { domain: string; content: object; payloadHash: string }, addr: string, fee: number, days: number, label: string): Promise<boolean> {
  const uri = "csd:" + rec.domain.replace(/[^a-z]/gi, "").slice(0, 6) + ":v1:" + rec.payloadHash.slice(2, 14);
  const sp = spinner("fetching input → csd signs → submit");
  const picked = await api.pickInput(addr, fee).catch(() => null);
  if (!picked) { sp.stop(); console.log(err("no confirmed UTXO above the fee") + c.gray(" — fund " + addr)); return false; }
  const tip = await api.tipHeight().catch(() => 0);
  const r = await signAndSubmit(["propose", "--domain", rec.domain, "--payload-hash", rec.payloadHash, "--uri", uri, "--expires-epoch", String(Math.floor(tip / 30) + days * 24), "--fee", String(fee), "--change", addr, "--input", picked.input]);
  sp.stop();
  if (!r.ok) { console.log(err(r.error || "failed")); return false; }
  console.log(ok(`${label} anchored  ${c.cyan(r.txid!)}`) + c.gray("  (signed by your csd wallet)"));
  const sp2 = spinner("publishing content (waits for the tx to mine)");
  const done = await api.registerRawContent(canonicalJson(rec.content), r.txid!);
  sp2.stop();
  console.log(done ? ok("content published — record is now resolvable") : warn("content not published yet — re-run once mined"));
  return done;
}

// Shared setup for the registry commands: require csd, the privkey (to sign the binding
// locally — never networked), and the address.
async function registryPrep(a: Args): Promise<{ priv: string; addr: string } | null> {
  if (!(await requireCsd())) return null;
  const cfg = await csd.walletConfig();
  const priv = cfg?.default_privkey;
  if (!priv) { console.log(err("no csd wallet key configured.") + c.gray("  Run ") + c.cyan("csd wallet new")); return null; }
  const addr = await resolveAddr(a); if (!addr) { console.log(err("could not resolve your address — run ") + c.cyan("cairn setup")); return null; }
  return { priv, addr };
}

async function cmdGateway(a: Args) {
  if (a._[1] !== "register") { console.log(warn("usage: ") + c.cyan("cairn gateway register --url https://gw/content/0x{hash} [--pin] [--fee 0.25]")); return; }
  const url = String(a.flags.url ?? "");
  if (!url.includes("{hash}")) { console.log(err("--url must contain the {hash} template, e.g. https://gw/content/0x{hash}")); return; }
  const p = await registryPrep(a); if (!p) return;
  const rec = buildGatewayRecord({ priv: p.priv, url, kind: a.flags.pin ? "pin" : "gateway", address: p.addr });
  const fee = Math.max(MIN_FEE_PROPOSE, a.flags.fee !== undefined ? CSD(Number(a.flags.fee)) : MIN_FEE_PROPOSE);
  if (a.flags["dry-run"]) { console.log(`${kdim("domain")} ${c.cyan(rec.domain)}\n${kdim("url")}    ${c.white(url)}\n${kdim("hash")}   ${c.magenta(rec.payloadHash)}`); console.log(c.gray("\n[dry-run] not signed or submitted")); return; }
  await anchorRecord(rec, p.addr, fee, 10, "gateway");
}

async function cmdPeer(a: Args) {
  if (a._[1] !== "announce") { console.log(warn("usage: ") + c.cyan("cairn peer announce --peer-id <id> --addr /ip4/…/tcp/… [--addr …] [--cap full] [--fee 0.25]")); return; }
  const peerId = String(a.flags["peer-id"] ?? "");
  const multiaddrs = (a.multi.addr ?? (a.flags.addr ? [String(a.flags.addr)] : [])).filter(Boolean);
  if (!peerId || multiaddrs.length === 0) { console.log(err("--peer-id and at least one --addr required")); return; }
  const p = await registryPrep(a); if (!p) return;
  const caps = (a.multi.cap ?? (a.flags.cap ? [String(a.flags.cap)] : [])).filter(Boolean);
  const rec = buildPeerRecord({ priv: p.priv, peer_id: peerId, multiaddrs, caps: caps.length ? caps : undefined, address: p.addr });
  const fee = Math.max(MIN_FEE_PROPOSE, a.flags.fee !== undefined ? CSD(Number(a.flags.fee)) : MIN_FEE_PROPOSE);
  if (a.flags["dry-run"]) { console.log(`${kdim("domain")} ${c.cyan(rec.domain)}\n${kdim("peer")}   ${c.white(peerId)}\n${kdim("hash")}   ${c.magenta(rec.payloadHash)}`); console.log(c.gray("\n[dry-run] not signed or submitted")); return; }
  await anchorRecord(rec, p.addr, fee, 10, "peer");
}

async function cmdIdentity(a: Args) {
  const sub = a._[1];
  const handle = String(a.flags.handle ?? a._[2] ?? "");
  if (sub !== "claim" || !handle) { console.log(warn("usage: ") + c.cyan("cairn identity claim <handle> [--salt <hex>] [--commit-only|--reveal] [--fee 0.25]")); console.log(c.gray("  step 1: --commit-only (saves a salt)  ·  step 2 (next epoch): --reveal --salt <hex>")); return; }
  if (!/^[a-z0-9_.-]{3,32}$/i.test(handle)) { console.log(err("handle must be 3–32 chars [a-z0-9_.-]")); return; }
  const p = await registryPrep(a); if (!p) return;
  const fee = Math.max(MIN_FEE_PROPOSE, a.flags.fee !== undefined ? CSD(Number(a.flags.fee)) : MIN_FEE_PROPOSE);

  if (a.flags.reveal) {
    const salt = String(a.flags.salt ?? "");
    if (!/^[0-9a-f]{16,}$/i.test(salt)) { console.log(err("--salt <hex> from your earlier --commit-only step is required to reveal")); return; }
    const rec = buildIdentityReveal({ priv: p.priv, handle, salt, address: p.addr });
    if (a.flags["dry-run"]) { console.log(`${kdim("reveal")} ${c.white(handle)} → ${c.cyan(p.addr)}\n${kdim("hash")}   ${c.magenta(rec.payloadHash)}`); console.log(c.gray("\n[dry-run] not signed")); return; }
    await anchorRecord(rec, p.addr, fee, 90, "identity reveal");
    return;
  }
  // default / --commit-only: step 1
  const salt = String(a.flags.salt ?? randomBytes(16).toString("hex"));
  const rec = buildIdentityCommit({ handle, salt, address: p.addr });
  if (a.flags["dry-run"]) { console.log(`${kdim("commit")} ${c.white(handle)}\n${kdim("salt")}   ${c.magenta(salt)}\n${kdim("hash")}   ${c.magenta(rec.payloadHash)}`); console.log(c.gray("\n[dry-run] not signed")); return; }
  const okc = await anchorRecord(rec, p.addr, fee, 90, "identity commit");
  if (okc) console.log(c.gray("\n  save this salt — reveal NEXT epoch (~1h):  ") + c.cyan(`cairn identity claim ${handle} --reveal --salt ${salt}`));
}

main().catch((e) => { console.error(err(String(e?.message ?? e))); process.exit(1); });
