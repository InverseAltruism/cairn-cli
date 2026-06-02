#!/usr/bin/env node
// cairn — command-line client for a Cairn signal board on Compute Substrate.
// Reads are public; posting needs CAIRN_TOKEN. Config via env: CAIRN_API, CAIRN_TOKEN, CAIRN_RPC.
import { CAIRN_API, MIN_FEE_PROPOSE, MIN_FEE_ATTEST, CSD_PER_COIN, csdToCoins } from "./lib/config.js";
import * as api from "./lib/api.js";
import { buildCommitment } from "./lib/item.js";
import { c, banner, bannerAnimated, rule, badge, bar, csd as csdFmt, ok, warn, err, key as kdim, pad, spinner, sleep, isTty, clearScreen } from "./lib/ui.js";

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
    console.log(`  ${c.magenta(c.bold("#" + (i + 1)))}  ${c.white(c.bold(r.title))}  ${badge(r.source)}${r.sealed ? "  " + c.gray(r.revealed ? "🔓 revealed" : "🔒 sealed") : ""}`);
    console.log(`      ${bar(r[sort] || r.totalWeight, max)}  ${csdFmt(r.totalWeight)} ${c.gray("·")} ${c.green(String(r.supporterCount))} ${c.gray("supporters · score " + r.avgScore + " · " + age(r.createdTime) + " ago")}${lens}`);
    console.log(c.gray(`      ${r.domain} · id ${String(r.id).slice(0, 22)}…`));
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
  process.stdout.write("\x1b[?25l");
  process.on("SIGINT", () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); });
  for (;;) {
    const r = await api.apiBoard(domain, window).catch(() => ({ items: [] }));
    clearScreen(); banner();
    rule(`watch · ${domain} · ${window} · ${new Date().toLocaleTimeString()}`);
    printRows(r.items);
    console.log(c.gray("\n  ") + c.green("●") + c.gray(" live · refreshes every 5s · Ctrl+C to exit"));
    await sleep(5000);
  }
}

async function cmdRecent() {
  const r = await api.apiActivity();
  banner(); rule("recent activity");
  for (const ev of r.activity ?? []) {
    const verb = ev.type === "support" ? c.green("◈ supported") : c.cyan("✎ proposed ");
    console.log(`  ${verb} ${c.white(String(ev.item).slice(0, 42))} ${c.gray("· " + age(ev.time) + " ago · " + (ev.amount / 1e8) + " CSD")}`);
  }
}

async function cmdShow(a: Args) {
  const id = a._[1];
  if (!id) { console.log(warn("usage: cairn show <id>")); return; }
  const r = await api.apiItem(id).catch(() => null);
  if (!r || !r.ok) { console.log(err("not found")); return; }
  const it = r.item;
  rule(it.title);
  console.log(`  ${badge(it.source)}  ${c.gray("·")}  ${c.cyan(it.domain)}`);
  console.log(`\n  ${c.white(it.body)}\n`);
  if (it.links?.length) console.log(`  ${kdim("links")}     ${it.links.map((l: string) => c.cyan(l)).join(", ")}`);
  const total = (r.supports ?? []).reduce((x: number, s: any) => x + s.weight, 0);
  console.log(`  ${kdim("support")}   ${csdFmt(total)} ${c.gray("from")} ${c.green(String(new Set((r.supports ?? []).map((s: any) => s.attester)).size))} ${c.gray("supporters")}`);
  console.log(`  ${kdim("proposer")}  ${c.gray(it.proposerHandle || it.proposer)}`);
  console.log(`  ${kdim("hash")}      ${c.magenta(it.payloadHash)}`);
  console.log(`  ${kdim("integrity")} ${r.integrityOk ? ok("content matches commitment") : err("MISMATCH")}`);
}

async function cmdVerify(a: Args) {
  const id = a._[1];
  if (!id) { console.log(warn("usage: cairn verify <id>")); return; }
  const sp = spinner("fetching + recomputing");
  const r = await api.apiItem(id).catch(() => null);
  if (!r || !r.ok) { sp.stop(); console.log(err("not found")); return; }
  const it = r.item;
  const { payloadHash } = buildCommitment({ v: 1, domain: it.domain, title: it.title, body: it.body, links: it.links ?? [] });
  const chain = await api.chainProposal(it.id);
  sp.stop();
  console.log(`${kdim("recomputed")}  ${c.magenta(payloadHash)}`);
  console.log(`${kdim("reported")}    ${c.magenta(it.payloadHash)}`);
  const contentOk = payloadHash.toLowerCase() === String(it.payloadHash).toLowerCase();
  if (chain?.payload_hash) {
    console.log(`${kdim("on-chain")}    ${c.magenta(chain.payload_hash)}`);
    console.log(contentOk && String(chain.payload_hash).toLowerCase() === payloadHash.toLowerCase()
      ? ok("VERIFIED — content matches the on-chain commitment (trustless, via CAIRN_RPC)")
      : err("MISMATCH"));
  } else {
    console.log(contentOk ? ok("content matches the reported commitment") + c.gray("  (set CAIRN_RPC to also check the chain directly)") : err("content does NOT match the reported hash"));
  }
}

async function cmdPropose(a: Args) {
  const domain = String(a.flags.domain ?? "");
  const title = String(a.flags.title ?? "");
  const body = String(a.flags.body ?? "");
  const links = a.multi.link ?? [];
  if (!domain || !title) { console.log(warn("usage: ") + c.cyan("cairn propose --domain csd:features --title <t> --body <b> [--link <url>] [--fee <base>]")); return; }
  const fee = Number(a.flags.fee ?? MIN_FEE_PROPOSE);
  const sp = spinner("posting to Cairn");
  try {
    const r = await api.apiPropose({ domain, title, body, links, fee: Number.isFinite(fee) && fee >= MIN_FEE_PROPOSE ? Math.floor(fee) : MIN_FEE_PROPOSE });
    sp.stop();
    console.log(r.ok ? ok(`proposed  ${c.cyan(r.id)}`) : err(r.error || "failed"));
  } catch (e: any) { sp.stop(); console.log(err(e.message)); }
}

async function cmdSupport(a: Args) {
  const id = a._[1];
  if (!id) { console.log(warn("usage: ") + c.cyan("cairn support <id> --fee <base> [--score 0-100] [--confidence 0-100]")); return; }
  const fee = Number(a.flags.fee ?? MIN_FEE_ATTEST);
  const sp = spinner("posting support to Cairn");
  try {
    const r = await api.apiSupport({ id, fee: Number.isFinite(fee) && fee >= MIN_FEE_ATTEST ? Math.floor(fee) : MIN_FEE_ATTEST, score: Number(a.flags.score ?? 75), confidence: Number(a.flags.confidence ?? 60) });
    sp.stop();
    console.log(r.ok ? ok(`supported  ${c.cyan(r.id)}`) : err(r.error || "failed"));
  } catch (e: any) { sp.stop(); console.log(err(e.message)); }
}

async function cmdDomains() {
  const r = await api.apiDomains();
  banner(); rule("categories");
  for (const dom of r.domains ?? []) console.log(`  ${c.cyan(pad(dom.key, 20))} ${c.white(dom.title)} ${c.gray(dom.count != null ? "(" + dom.count + ")" : "")}`);
  // open domains: anyone can create one by proposing into it (cairn ls <domain> works for any).
  const disc = r.discovered ?? [];
  if (disc.length) {
    console.log(c.gray("\n  open domains (created by proposing into them):"));
    for (const d of disc) console.log(`  ${c.cyan(pad(d.key, 20))} ${c.gray((d.count != null ? d.count + " items" : "") + (d.totalWeight ? " · " + csdToCoins(d.totalWeight) + " CSD" : ""))}`);
  }
}

async function cmdWall() {
  const r = await api.apiWall();
  const stones = r.stones ?? [];
  banner(); rule(`the wall · ${r.totals?.stones ?? 0} stones · ${r.totals?.boosts ?? 0} boosts · epoch ${r.epoch ?? "?"}`);
  if (r.king) console.log(`  ${c.green("★ KING")}  ${c.white(c.bold(r.king.message))}  ${csdFmt(r.king.weight)} ${c.gray("· " + r.king.boosts + " boosts")}`);
  if (!stones.length) {
    console.log(c.gray("\n  no stones yet — place one with the Cairn Wallet, or:"));
    console.log(c.green("  cairn propose --domain cairn:wall --title '<message>'"));
    return;
  }
  const max = stones[0]?.weight || 1;
  stones.slice(0, 25).forEach((s: any, i: number) => {
    console.log("");
    console.log(`  ${c.magenta(c.bold("#" + (i + 1)))}  ${c.white(c.bold(s.message))}${i === 0 ? "  " + c.green("★") : ""}`);
    console.log(`      ${bar(s.weight, max)}  ${csdFmt(s.weight)} ${c.gray("·")} ${c.green(String(s.boosts))} ${c.gray("boosts · " + age(s.ts) + " ago")}${(s.tags && s.tags.length) ? c.gray("  #" + s.tags.join(" #")) : ""}`);
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
  banner(); rule(`profile · ${p.handle || addr}`);
  if (p.handle) console.log(`  ${kdim(pad("handle", 13))} ${c.white(p.handle)}`);
  if (p.bio) console.log(`  ${kdim(pad("bio", 13))} ${c.gray(p.bio)}`);
  if (p.github) console.log(`  ${kdim(pad("github", 13))} ${c.cyan(p.github)} ${p.githubVerified ? ok("verified") : c.gray("(unverified)")}`);
  console.log(`  ${kdim(pad("address", 13))} ${c.gray(p.addr || addr)}`);
  console.log(`  ${kdim(pad("trust", 13))} ${c.white((rep.trust ?? 0).toFixed(2))}`);
  console.log(`  ${kdim(pad("work", 13))} ${c.green(String(rep.proposed ?? 0))} proposed ${c.gray("·")} ${c.green(String(rep.shipped ?? 0))} shipped ${c.gray("·")} ${c.green(String(rep.acceptedWork ?? 0))} accepted ${c.gray("·")} ${c.green(String(rep.reviews ?? 0))} reviews`);
}

async function cmdLeaderboard() {
  const r = await api.apiLeaderboard();
  banner(); rule("reputation leaderboard");
  const lb = r.leaderboard ?? [];
  if (!lb.length) { console.log(c.gray("  no ranked builders yet — reputation accrues from accepted quest work.")); return; }
  lb.slice(0, 25).forEach((e: any, i: number) => {
    console.log(`  ${c.magenta(c.bold(pad("#" + (i + 1), 4)))} ${c.white(pad(e.handle || e.addr, 26))} ${c.gray("trust")} ${c.white((e.trust ?? 0).toFixed(2))} ${c.gray("· " + (e.shipped ?? e.acceptedWork ?? 0) + " shipped · " + (e.proposed ?? 0) + " proposed")}`);
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
    console.log(`  ${c.magenta(c.bold("#" + (i + 1)))} ${c.white(c.bold(q.title))} ${c.gray("· " + (q.status || "?"))}`);
    console.log(`      ${c.gray("reward " + reward + " · demand " + csdFmt(q.demandWeight || 0) + " · " + (q.demandSupporters || 0) + " backers")}`);
    console.log(c.gray(`      id ${String(q.id).slice(0, 22)}…`));
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
  cmd("propose", "--domain <d> --title <t> --body <b>", "post an item (needs CAIRN_TOKEN)");
  cmd("support", "<id> --fee <base>", "back an item (needs CAIRN_TOKEN)");
  console.log(c.gray("\n  lenses (--sort): " + Object.keys(LENS).join(" · ")));
  console.log(c.gray(`  api: ${CAIRN_API}  ·  1 CSD = ${CSD_PER_COIN} base · propose ≥ ${MIN_FEE_PROPOSE} · attest ≥ ${MIN_FEE_ATTEST}`));
  console.log(c.gray("  config: CAIRN_API (board url) · CAIRN_TOKEN (instance write token, to post) · CAIRN_RPC (trustless verify)"));
  console.log(c.gray("  display: honors NO_COLOR · --no-color · --no-anim · TERM=dumb (color/animation auto-off when piped)"));
  console.log(c.gray("  keyless non-custodial posting + sealed claims: use the Cairn Wallet (browser extension)."));
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
    case "wall": return cmdWall();
    case "network": case "stats": return cmdNetwork();
    case "quests": return cmdQuests();
    case "profile": return cmdProfile(a);
    case "leaderboard": case "lb": return cmdLeaderboard();
    case "propose": return cmdPropose(a);
    case "support": return cmdSupport(a);
    default: return help();
  }
}
main().catch((e) => { console.error(err(String(e?.message ?? e))); process.exit(1); });
