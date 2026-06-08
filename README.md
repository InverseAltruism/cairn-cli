# cairn-cli

A command-line client for **Compute Substrate / Cairn** — browse the board, and **send CSD,
propose, attest, and place stones on the Wall** straight from your terminal.

For the people who'd rather not put a key in a browser extension: **cairn-cli never holds your
key.** Reads are plain HTTP. For writes it drives your **own installed `csd` wallet** — `csd`
signs with your key (CSD_SIG_V1), and cairn-cli adds the Cairn layer on top: it computes the
canonical payload hash, fetches a spendable input from the Cairn proxy (so you don't need a
synced local node), registers your off-chain content, and gives you the board / wall / network
views the raw `csd` CLI doesn't have. Browsing needs no `csd` binary and no keys.

## Install

```bash
npm install -g @inversealtruism/cairn-cli
```

Or run it without installing:

```bash
npx @inversealtruism/cairn-cli ls
```

Or build from source:

```bash
git clone https://github.com/InverseAltruism/cairn-cli
cd cairn-cli
npm install
npm run build
npm link
```

## Use

```bash
cairn                        # help
cairn domains                # list categories + open domains
cairn ls csd:tools           # browse a category (or any open domain, or: cairn ls)
cairn ls --window trending   # trending / 7d / 30d / all
cairn ls --sort quadratic    # lens: totalWeight|quadratic|repWeight|conviction|supporterCount|createdHeight
cairn watch                  # live auto-refreshing board
cairn recent                 # recent proposals and support
cairn show   <id>            # item detail and integrity check
cairn verify <id>            # recompute the content hash and check it
cairn wall                   # the Wall — top stones + the reigning King
cairn network                # live network telemetry (alias: cairn stats)
cairn quests                 # open quests
cairn profile <addr>         # identity + on-chain reputation
cairn leaderboard            # top builders by reputation
cairn ls --json              # machine-readable output
```

## Wallet (transacting — uses your own `csd` wallet)

One-time: install Compute Substrate's `csd` CLI and create/import your key.

```bash
csd wallet new                          # or: csd wallet init --privkey <your key>
cairn setup                             # checks csd + wallet, shows your address + balance
```

Then transact — cairn-cli builds the request, `csd` signs with your key, and the tx is submitted
through the Cairn proxy (no local node required):

```bash
cairn address                           # your address + balance (alias: whoami, balance)
cairn send --to 0x… --amount 1.5        # transfer CSD (--output 0x…:0.5 ×N for many, --fee <CSD>)
cairn propose --domain csd:features --title "Wallet GUI" --body "…" --link https://…
cairn support <id> --fee 0.1 --score 90 --confidence 80
cairn wall place "gm, Compute Substrate"
```

Fees and amounts are in **CSD** (e.g. `--amount 1.5`, `--fee 0.05`). Minimums: 0.25 CSD to propose,
0.05 CSD to attest. Support is a paid demand signal, not a payment to the author; fees go to miners.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `CAIRN_API` | `https://cairn-substrate.com` | the board / proxy to talk to (use your own, e.g. `http://127.0.0.1:7777`) |
| `CAIRN_CSD` | `csd` | path to your installed `csd` binary (signs your transactions) |
| `CAIRN_ADDR` | – | your public addr20; skips deriving it from the csd wallet |
| `CAIRN_RPC` | – | optional csd node RPC; enables fully trustless `verify` (recompute the hash + confirm on-chain) |
| `CAIRN_TOKEN` | – | board-operator write token (operator convenience; normal users sign with `csd` instead) |

## How it works

- `browse`, `show`, `recent`, `watch`, `wall`, `network`, `quests` read the board's public API.
- `verify` fetches an item, recomputes `sha256(canonical content)` locally, and if `CAIRN_RPC` is set,
  confirms that hash is the one committed on-chain. You trust the math, not the server.
- `send` / `propose` / `support` / `wall place`: cairn-cli fetches a spendable input from the Cairn
  proxy, hands it to **your** `csd` (which signs with your wallet key — for these commands the key
  stays inside `csd` and never enters the cairn-cli process), then submits the signed transaction
  through the proxy and (for proposals) registers the off-chain content. Sealed claims and
  Sign-in-with-CSD live in the Cairn Wallet.
- **L3 registry commands** (`gateway register`, `peer announce`, `identity claim`) are the one
  exception: they sign a registry *binding* with `@inversealtruism/csd-registry`, so cairn-cli reads
  your private key from `csd wallet config` and signs **in-process** (the key is never networked — only
  the signed canonical content is published). Because these load key material into the Node process,
  the `csd-registry` / `csd-codec` dependencies are **pinned to exact versions** (no caret ranges) to
  shrink the supply-chain surface. If you only ever `send`/`propose`/`support`, your key never leaves `csd`.

## License

MIT
