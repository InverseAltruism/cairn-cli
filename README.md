# cairn-cli

A command-line client for a Cairn signal board on Compute Substrate. Browse what the community is
backing, and with a token, propose or support items, all from your terminal.

Cairn is a fee-weighted "paid attention" board: people spend CSD to surface what should be built,
fixed, or funded. `cairn-cli` is a thin HTTP client for a Cairn instance. Browsing needs no `csd`
binary and no key files.

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

Posting needs a token from the board operator:

```bash
export CAIRN_TOKEN=…         # the instance's write token
cairn propose --domain csd:features --title "Wallet GUI" --body "A graphical wallet…" --link https://…
cairn support <id> --fee 5000000 --score 90 --confidence 80
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `CAIRN_API` | `https://cairn-substrate.com` | the board to talk to (use your own, e.g. `http://127.0.0.1:7777`) |
| `CAIRN_TOKEN` | – | required only to post (propose or support) |
| `CAIRN_RPC` | – | optional csd node RPC; enables fully trustless `verify` by recomputing the hash and confirming the one on-chain |

## How it works

- `browse`, `show`, `recent`, and `watch` read the board's public API.
- `verify` fetches an item, recomputes `sha256(canonical content)` locally, and if `CAIRN_RPC` is set,
  confirms that hash is the one committed on-chain. You trust the math, not the server.
- `propose` and `support` post through the instance, which records the item and submits the on-chain
  proposal or attestation. Fees go to miners. Support is a paid demand signal, not a payment to the
  author.

Fees are in base units (1 CSD = 1e8). Minimums are 0.25 CSD to propose and 0.05 CSD to attest.

## License

MIT
