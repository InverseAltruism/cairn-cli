> Onboarding briefing for coding agents and contributors. The canonical copy is `AGENTS.md`; this file imports it, so edit `AGENTS.md` only.
> Production and operations specifics are intentionally out of scope here and are maintained privately.

# CLAUDE.md (cairn-cli)

The full technical briefing for this repo lives in `AGENTS.md` (the non-custodial terminal client: command surface, invariants, dev/test/publish, incident history, cross-repo map). It is the single source of truth; read it first and keep both files in sync by editing `AGENTS.md`.

@AGENTS.md

## Claude Code operating notes

- **This CLI moves real CSD by driving the user's own `csd` signing binary; it must never hold or transmit a key** (only the three L3 registry commands sign in-process, never networked). Single most important rule set: never trust the proxy (local txid is authoritative; error strings never mean success; input values cross-checked; fee sanity cap because the chain has no max fee), and no floats on money.
- Consensus shapes come from the pinned packages; the one deliberate exception is the CLI `feeCap` (KEEP-DISTINCT from csd-tx's). Every cairnx-core gate release forces a re-pin + patch release.
- Package manager is npm (not pnpm). `npm run build` = clean + tsc (the clean matters).
- No em dashes in user-facing docs. Security fixes must not regress UX on legitimate hot paths. Maintainers handle commit/tag/publish; propose changes rather than releasing them.
