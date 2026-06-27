# merge-oracle 🔮

> *"The cards have spoken. This PR shall not merge before Tuesday."*

A mystical CLI oracle that divines the fate of your pull requests via tarot, runes, tea leaves, or I-Ching. Half useful PR review, half theatre — feed it a diff, get back a dramatic ritual reading.

## Status
🌒 Approaching first release. Tarot, runes, tea-leaves, and I-Ching methods are wired up end-to-end; npm publish is gated behind the `release` workflow (tag `v*`). See [PLAN.md](./PLAN.md) and [CHANGELOG.md](./CHANGELOG.md).

## Quick taste (planned UX)
```bash
oracle read https://github.com/you/repo/pull/42
oracle read ./feature.diff --method=runes
gh pr diff 42 | oracle read --method=tarot --json
```

## Install

```bash
npm install -g @rwrife/merge-oracle
oracle --version
```

Published from CI on every `v*` tag — see `.github/workflows/release.yml`.

## Local development
Requires Node.js ≥ 18.

```bash
npm ci
npm run build      # compile TypeScript -> dist/
npm test           # run vitest suite
npm run dev hello  # run the CLI directly from src (via tsx)
```

After `npm run build`, you can invoke the CLI as `node dist/cli.js`:

```bash
node dist/cli.js --version
node dist/cli.js hello --name ryan

# load a diff (M2: source loaders)
node dist/cli.js read ./feature.diff
node dist/cli.js read https://github.com/you/repo/pull/42
git diff main | node dist/cli.js read -
node dist/cli.js read ./feature.diff --json
node dist/cli.js read ./feature.diff --offline   # canned mystical drivel, no LLM
node dist/cli.js read ./feature.diff --method=tarot --offline
node dist/cli.js methods                          # list available divination methods
node dist/cli.js methods --json                   # same list, machine-readable
```

### Tarot reading (M4)
The `tarot` method draws three Major Arcana cards (Past / Present / Future) seeded by a SHA-256 hash of the diff, so the same diff always yields the same spread. Cards may land upright or reversed, and the renderer flips reversed cards visually in the ASCII spread.

### Tea leaves reading
The `tea-leaves` method does not seed cards from a hash — it actually *reads the shape of the diff itself*. A small parser walks the unified diff to count files, additions, deletions, hunk topology, and directories touched; those stats then promote leaf-shapes in the cup (e.g. `mountain` for big diffs, `knife` when deletions dominate, `scales` for balanced add/delete, `web` when many files are entangled). Three shapes settle into **Rim / Side / Bottom** — imminent, present, distant.

```bash
node dist/cli.js read ./feature.diff --method=tea-leaves --offline
```

### Runes reading (M5)
The `runes` method casts three Elder Futhark runes (Situation / Obstacle / Outcome) seeded by a different slice of the diff hash. Reversed runes are read as *merkstave* — their warning meaning.

```bash
node dist/cli.js read ./feature.diff --method=runes --offline
```

### I-Ching reading
The `i-ching` method casts a hexagram from the diff hash — six lines drawn under traditional yarrow-stalk probabilities. Changing lines (old yang / old yin) transform the Primary hexagram into a Derived one, and the oracle reads the transformation as the merge prophecy. Stable casts (no changing lines) read the Primary alone.

```bash
node dist/cli.js read ./feature.diff --method=i-ching --offline
```

### Numerology reading
The `numerology` method reads the *numbers* of a diff — no hash, no LLM trickery in the symbol derivation, just pure arithmetic mysticism. It collects four counts (total churn, files touched, hunks, longest contiguous run of additions) and reduces each via classic digit-sum-mod-9, **preserving master numbers 11 / 22 / 33**. The four resulting digits map to **Life Path / Expression / Soul Urge / Personality** and are woven into a single merge prophecy.

```bash
node dist/cli.js read ./feature.diff --method=numerology --offline
```

### Cursing your repo
Opt-in pre-push hook. `oracle bless --install` writes a tiny `.git/hooks/pre-push` script that pipes your outgoing diff through `oracle bless --check` (pure offline heuristics — no LLM, no network) and aborts the push when the verdict's `severity` meets/exceeds `ORACLE_BLESS_THRESHOLD` (default `8`). Catches the obvious sins: secret-shaped strings in additions (`AKIA…`, `sk-…`, `ghp_…`, PEM keys), removed test files, mass-deletion sprees, `TODO: revert before merge` markers, and absurdly-huge diffs.

```bash
node dist/cli.js bless --install         # writes .git/hooks/pre-push (marker-tagged, idempotent)
node dist/cli.js bless --status          # installed / not-installed / foreign-hook-present
node dist/cli.js bless --uninstall       # removes only the oracle-managed hook
ORACLE_BLESS_THRESHOLD=6 git push        # tighten the threshold per-push
git push --no-verify                     # standard git escape hatch
```

Run `node dist/cli.js bless --check ./some.diff` to preview the verdict without installing anything. `--force` lets `--install` overwrite a non-oracle pre-push hook (and lets `--uninstall` remove one).

### MCP server mode
The oracle can expose itself as an [MCP](https://modelcontextprotocol.io) server over stdio, so Claude Desktop / Cursor / Codex can summon readings inline:

```bash
node dist/cli.js mcp
```

Tools exposed:
- `oracle.read` — divines a PR/diff using a chosen method (`source`, `method?`, `offline?`, `json?`)
- `oracle.methods` — lists available divination methods

Wire format is line-delimited JSON-RPC 2.0 (one request per line). Example Claude Desktop config entry:

```json
{
  "mcpServers": {
    "merge-oracle": {
      "command": "oracle",
      "args": ["mcp"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

For experiments without an LLM key, call `oracle.read` with `"offline": true`.

### GitHub Action — sticky PR readings
The repo also ships a composite GitHub Action so every PR automatically gets a mystical reading posted as a **sticky comment** (updated in place on each push, not re-posted). Drop this into `.github/workflows/merge-oracle.yml` in any repo:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  reading:
    runs-on: ubuntu-latest
    steps:
      - uses: rwrife/merge-oracle@v1
        with:
          method: tarot            # tarot | runes | tea-leaves | i-ching | numerology
          offline: "false"          # use canned drivel when no LLM is configured
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

A ready-to-copy example lives at [`examples/workflow.yml`](./examples/workflow.yml). Inputs:

| input | default | description |
| --- | --- | --- |
| `method` | `tarot` | Divination method id. |
| `offline` | `false` | If `true`, skip the LLM and use the canned reading. |
| `version` | `latest` | npm version of `@rwrife/merge-oracle` to install. |
| `node-version` | `20` | Node version used by the action. |
| `marker` | `<!-- merge-oracle:sticky -->` | Hidden marker used to find/update the sticky comment. |
| `github-token` | _required_ | Needs `pull-requests: write`. |
| `openai-api-key` / `openai-base-url` / `openai-model` | _empty_ | Passed through as `OPENAI_*` env vars. |

### How to add a divination method
Methods are plain TypeScript files in `src/methods/`. The registry auto-discovers any sibling module that exports an object implementing the `DivinationMethod` interface (`id`, `name`, `describe`, `draw`, `readingPrompt`, `render`).

1. Create `src/methods/<your-method>.ts`.
2. Export a `DivinationMethod` (named or default export — both work). Pick a unique `id`.
3. Optionally drop deck data in `src/data/decks/` (it ships to `dist/data/` automatically).
4. Add tests in `tests/<your-method>.test.ts`.
5. `npm run build && node dist/cli.js methods` — your method appears in the list and is usable via `--method=<id>`.

Files starting with `_` and the shared `types.ts` are skipped by discovery.

### LLM configuration (M3)
The oracle calls any OpenAI-compatible chat endpoint. Configure via env vars:

- `OPENAI_API_KEY` — required unless `--offline` is passed
- `OPENAI_BASE_URL` — defaults to `https://api.openai.com/v1`; point at LM Studio, Ollama (`http://localhost:11434/v1`), vLLM, etc.
- `OPENAI_MODEL` — defaults to `gpt-4o-mini`

Without a key, `oracle read` exits 2 and reminds you to either set the key or pass `--offline`.

The `read` command auto-detects the source from the argument shape:
- a GitHub PR URL → shells out to `gh pr view` + `gh pr diff`
- `-` (or empty) → reads piped stdin
- anything else → treated as a path to a `.diff`/`.patch` file

CI runs `npm ci && npm run build && npm test` on every push and PR (see `.github/workflows/ci.yml`).

## License
MIT — see [LICENSE](./LICENSE).
