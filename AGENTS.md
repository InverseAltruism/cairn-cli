# cairn-cli

> Onboarding briefing for coding agents and contributors. AGENTS.md is the canonical copy; CLAUDE.md imports it, so edit AGENTS.md only.
> Production and operations specifics are intentionally out of scope here and are maintained privately.

`@inversealtruism/cairn-cli` (npm, v0.3.19, bin `cairn`) is the non-custodial terminal client for Compute Substrate / Cairn: browse the board/wall/network/quests, and send CSD / propose / attest / place Wall stones / send CairnX tokens, all without ever holding a private key. For writes it drives the user's own installed upstream `csd` wallet binary (which signs with CSD_SIG_V1); cairn-cli only orchestrates: computes canonical payload hashes, fetches a spendable input from the Cairn proxy (no local node needed), submits through the proxy, and registers off-chain content. Target user: people who'd rather not put a key in a browser extension. Sealed claims and Sign-in-with-CSD (SIWC) deliberately live in the Cairn Wallet, not here.

One exception to "never touches the key": the L3 registry commands (gateway register, peer announce, identity claim) sign a registry binding in-process via @inversealtruism/csd-registry, reading the privkey from `csd wallet config` (key never networked).

## The stack around it

Default API base https://cairn-substrate.com, a Cairn board instance whose public /api and /api/rpc routes proxy reads and tx submission to a CSD node (which is what makes the CLI node-less). CAIRN_API can point at any instance, including your own (e.g. http://127.0.0.1:7777, the README's example). CairnX state reads use the fallback chain hardcoded in lib/cairnx.ts: CAIRNX_API if set, else http://127.0.0.1:8794/cairnx (a local service, if you run one), else https://cairn-substrate.com/trade/api/cairnx. Consensus shapes come from pinned @inversealtruism packages, never hand-mirrored.

## Architecture

Zero runtime deps beyond four pinned @inversealtruism packages; Node >= 20; plain tsc build to dist/ (no bundler). src/ (~1,660 lines):

- `cli.ts` (~1,000 lines): argv parser, all command handlers, and the money-safety guards:
  - CSD() exact decimal-string conversion (no floats on money, ever; NaN on garbage)
  - feeCap/feeSanity (fee <= max(1 CSD, 25% of value moved); --max-fee overrides). KEEP-DISTINCT from csd-tx's feeCap (different denominator/layer; marked in code, do not unify).
  - pickAndShow(): picks one confirmed UTXO from the proxy, cross-verifies its value against an independent CAIRN_RPC node (refuses on mismatch), always displays input/change/implied fee, loud UNVERIFIED warning otherwise.
  - resolveAddr(): --address -> CAIRN_ADDR -> wallet default_change_addr20 (authoritative, anti-poison cross-check) -> cache -> last-resort IN-PROCESS key derivation (csd-crypto addrFromPriv; L7: no key on argv).
  - signAndSubmit(): evidence-based success; authoritative txid is the LOCALLY signed one; divergent proxy txid = hard failure; error strings never trusted.
  - freshTip(): refuses to build value txs against a stale/frozen tip (fail-closed on stale; --force-stale override).
  - sameHost/canonHost: "trustless" claims refused when CAIRN_RPC shares a machine with CAIRN_API.
- `lib/api.ts`: Cairn HTTP client (redirect:"error" so the operator token can't leak on a 30x), proxy bridge, independent-node checks.
- `lib/csd.ts`: trusted-csd-binary resolution (CAIRN_CSD must be absolute; canonical locations beat PATH; refuses world-writable/transient/cwd; symlink-TOCTOU resolved; execFile, no shell). deriveAddr() derives the addr20 in-process via csd-crypto addrFromPriv (L7: the privkey never reaches an argv).
- `lib/cairnx.ts`: CairnX read client with base fallback; buildTransferRecord via cairnx-core transfer() + csd-codec canonicalJson (single canonicaliser, byte-identical to the resolver); exact humanToBase/baseToHuman string/BigInt math.
- `lib/config.ts`: env config; local cache ~/.config/cairn-cli/config.json holds the PUBLIC address only, never a key (0700/0600).
- `lib/item.ts`: canonical item record + integrity commitment: stableStringify (recursively sorted keys, no whitespace) -> sha256 payload_hash; buildCommitment/verifyContent back `verify <id>` (no salt; the board is public, hash is tamper-evidence not secrecy).
- `lib/ui.ts`: terminal UI; san() ANSI/OSC/control-char stripper on ALL displayed untrusted strings, NEVER on bytes that get hashed.

## Command surface

Browse (no key needed): domains, ls|list|top [domain] [--window] [--sort] [--json], watch, recent, show <id>, verify <id> (recompute sha256 locally; trustless with independent CAIRN_RPC), wall, network|stats, quests, profile <addr>, leaderboard.
Wallet (drives csd): setup|doctor, address|whoami|balance, send --to 0x..40 --amount <CSD> [--output a:v ...] [--fee] [--max-fee] [--dry-run] [--wait] [--force-stale], propose|post, support <id> --fee <CSD>, wall place "<msg>".
CairnX: tokens [address], token-info <TICKER>, token-send --ticker T --to 0x..40 --amount <n> [--base-units] [--expect-decimals <N>] [--dry-run] [--yes] (the ONE CairnX write: anchors a canonical transfer record as a 0.25 CSD Propose), names [address], name <name>.
L3 registry (in-process signing): gateway register, peer announce, identity claim [--commit-only|--reveal --salt <hex>].

Fee floors: propose >= 0.25 CSD, attest >= 0.05 CSD (imported from csd-codec). Default send fee 0.01 CSD. Every write path: fee sanity -> fresh-tip gate -> pickAndShow -> csd signs -> proxy submit -> evidence-based confirm.

## Invariants and red lines

- Never holds/transmits a private key for send/propose/support/token-send. Only the three registry commands load the key in-process (never networked). Do not widen that boundary.
- Which binary signs is a trust decision (H-1 in code comments): keep the canonical-locations-before-PATH resolution and the refusals.
- Never trust the proxy: local txid authoritative; error strings never mean success; "mined" claims need independent CAIRN_RPC on a different machine; input values cross-checked; fee sanity cap (the chain has NO max fee; an under-reported input silently burns change as fee).
- No floats on money; unparseable fees fall DOWN to the default with a warning.
- Consensus shapes from pinned packages only (TICKER_RE/NAME_RE/ADDR_RE/MAX_AMOUNT/transfer() from cairnx-core; MIN_FEE_* and canonicalJson from csd-codec; epochOf/EPOCH_LEN from cairnx-core). Exception: the CLI feeCap, marked KEEP-DISTINCT.
- san() on every displayed untrusted string; never on hashed bytes.
- Exact version pins, no carets. Every cairnx-core consensus-gate release forces a CLI re-pin + patch release (the dominant pattern in this repo's history).
- Pending name reservations (a .csd name bought but not yet finalized) must never display as owned; keep the "(finalizing)" marker.
- Security fixes must never regress UX on a legitimate hot path: no added prompts, latency, or spurious refusals for honest users.
- No em dashes in user-facing docs. Maintainers handle commits, tags, and npm publishes; contributors should propose changes, not release them.

## Dev workflow

Package manager is npm (some sibling @inversealtruism workspaces use pnpm; this repo does not).

```bash
git clone https://github.com/InverseAltruism/cairn-cli && cd cairn-cli
npm ci --no-audit --no-fund
npm run build        # clean && tsc (clean matters: tsc never deletes stale outputs)
npm run dev -- ls    # tsx src/cli.ts
npm test             # build + security.mjs + cairnx.mjs + e2e.mjs
node dist/cli.js ls
```

Optional: `bash .githooks/install.sh` activates the gitleaks secret-scanning pre-commit hook.

To develop against your own stack instead of the public instance, set the README's env vars: CAIRN_API (your board instance), CAIRNX_API (pin one CairnX base), CAIRN_RPC (your own node, enables the independent cross-checks), CAIRN_CSD (absolute path to your csd binary).

## Testing

- test/security.mjs: pen-test suite with a hostile in-process HTTP server (malicious API + RPC) and a mock csd binary driving the real built CLI. Asserts no terminal injection, no false "VERIFIED trustless" when RPC==API host, malformed txids rejected, token not leaked to redirects, F13 cache-poison recovery. GOTCHA: must use async spawn, never spawnSync (mock server shares the event loop; spawnSync makes ANSI checks pass vacuously; a harness-sanity check guards this).
- test/cairnx.mjs: offline; byte-exact transfer-record fixtures pinned against cairnx-core, humanToBase edges, base fallback semantics, dry-run/decimals guards vs a mock API.
- test/e2e.mjs: black-box vs a live Cairn instance ($CAIRN_API, default http://127.0.0.1:7777); read-only by default; real writes only with CLI_E2E_WRITE=1.

## Release and publish

npm publish (public) with a transient mktemp --userconfig token, deleted immediately. The ecosystem-wide "pnpm publish NOT npm" rule applies to the pnpm workspaces (csd-sdk), NOT this repo: cairn-cli is npm end-to-end (package-lock.json, CI `cache: npm` + npm ci; no pnpm lockfile). prepublishOnly = clean + tsc; the clean ritual exists because 0.3.1 nearly shipped stale dist artifacts. Ships only dist + README. CI: Node 22, npm ci -> build -> test (no publish job).

## Gotchas and incident history

- Two-mempool trap (real bug, fixed): csd's auto-submit targets csd's own configured node, whose mempool may not be the one the board's miner-connected node reads, so a tx could sit in the wrong mempool and never appear on the board. The CLI therefore ALWAYS submits via the Cairn proxy itself (see the comment above signAndSubmit in cli.ts).
- Residual trust assumption, by design and documented in code (CLI-C1 in cli.ts): with CAIRN_RPC unset the CLI cannot independently recompute input values (it ships no codec for that), so the picked input is proxy-trusted; the mitigations are the loud UNVERIFIED warnings plus the fee-sanity cap. The paired hard rule (CLI-C3): the locally signed txid is the only one ever trusted; a divergent proxy-reported txid is a hard failure.
- Key-on-argv (H-2 in code comments; FIXED, L7): address derivation from the wallet key is now IN-PROCESS via csd-crypto addrFromPriv (byte-identical to `csd wallet recover`), so the privkey never reaches a /proc-visible csd argv. Still a last resort (prefer a configured change address, which also restores the F13 anti-poison cross-check), and still cached, but a re-derive is now harmless.
- Hostile-API display DoS: read-API amounts parse defensively (0n on garbage).
- Token decimals come from an unauthenticated read API (CLI-C5 / F10): the human->base scale is only as trustworthy as the gateway. The interactive path cross-checks across bases, refuses on disagreement, and prints the exact base-unit integer before signing; automation (--yes / piped) skips the confirm prompt, so `token-send --base-units` interprets --amount as raw base units (bypassing the untrusted scale entirely - the fund-safe automation path), and `--expect-decimals <N>` fails closed if the served decimals differ.
- send needs ONE confirmed UTXO covering amount+fee; fragmented wallets must consolidate first (a recurring user pain point).
- All animation gates on TTY; piped output and e2e regexes depend on that; no unguarded ANSI.

## State snapshot (2026-07-09; verify with git before trusting)

Version 0.3.19, branch master. Snapshot HEAD f08b067 (re-pin cairnx-core 0.1.35; check-consumer-pins passes). Pins verified current at snapshot: cairnx-core 0.1.35, csd-codec 0.1.15, csd-registry 0.1.16. Neighbor observation, visible in its public package.json: sibling consumer @inversealtruism/cairn-sdk 0.2.1 still carries stale pins (cairnx-core 0.1.34, csd-tx 0.1.15); this repo is already coherent. Tags through v0.3.19. MIT.

## Cross-repo map

Depends on (exact pins): cairnx-core, csd-codec, csd-registry, and csd-crypto (all @inversealtruism packages published from the csd-sdk workspace; verify exact versions in package.json). csd-crypto (added as a DIRECT pin for L7's in-process addrFromPriv) must stay at the exact version csd-registry transitively pins - do not float, since it handles key material. Runtime couplings: the user's installed upstream csd binary (github.com/compute-substrate/compute-substrate) does all wallet signing; a Cairn board instance's /api + /api/rpc proxy (a 401 means a password-gated instance); the CairnX state API. The csd-sdk side runs a check-consumer-pins script that validates this repo's pins from the other direction (referenced in this repo's commit history). Sibling consumer @inversealtruism/cairn-sdk pins overlapping csd-sdk packages; pin drift between the two consumers is common after a csd-sdk publish, so check both.
