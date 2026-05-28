# cairn-cli

A small command-line client for a **Cairn** signal board on Compute Substrate — browse what the
community is backing, and (with a token) propose/support items, right from your terminal.

Cairn is a fee-weighted "paid attention" board: people spend CSD to surface what should be
built, fixed, or funded. `cairn-cli` is a thin HTTP client of a Cairn instance — no `csd`
binary or key files required for browsing.

## Install

```bash
npm install -g cairn-cli
# or run without installing:
npx cairn-cli ls
# or from source:
git clone https://github.com/InverseAltruism/cairn-cli && cd cairn-cli && npm install && npm run build && npm link
```

## Use

```bash
cairn                      # help (and a little cyberpunk)
cairn domains             # list categories
cairn ls csd:tools        # browse a category (or: cairn ls  for all)
cairn ls --window trending   # trending / 7d / 30d / all
cairn watch               # live auto-refreshing board
cairn recent              # recent proposals + support
cairn show   <id>         # item detail + integrity check
cairn verify <id>         # recompute the content hash and check it
cairn ls --json           # machine-readable output
```

Posting (needs a token from the board operator):

```bash
export CAIRN_TOKEN=…       # the instance's write token
cairn propose --domain csd:features --title "Wallet GUI" --body "A graphical wallet…" --link https://…
cairn support <id> --fee 5000000 --score 90 --confidence 80
```

## Config (env)

| var | default | purpose |
|---|---|---|
| `CAIRN_API` | `https://cairn-substrate.com` | the board to talk to (use your own, e.g. `http://127.0.0.1:7777`) |
| `CAIRN_TOKEN` | – | required only to **post** (propose/support) |
| `CAIRN_RPC` | – | optional csd node RPC; enables fully **trustless `verify`** (recompute the hash and confirm it's the one on-chain) |

## How it works

- **Browse / show / recent / watch** read the board's public API.
- **verify** fetches an item, recomputes `sha256(canonical content)` locally, and (if `CAIRN_RPC`
  is set) confirms that hash is the one committed on-chain — so you trust math, not the server.
- **propose / support** post through the instance (which records the item and submits the
  on-chain proposal/attestation). Fees go to miners; support is a paid demand signal, not a
  payment to the author.

Notes: fees are in base units (1 CSD = 1e8). Minimums: propose 0.25 CSD, attest 0.05 CSD.
MIT licensed.
