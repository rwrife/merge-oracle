# merge-oracle 🔮

> *"The cards have spoken. This PR shall not merge before Tuesday."*

A mystical CLI oracle that divines the fate of your pull requests via tarot, runes, tea leaves, or I-Ching. Half useful PR review, half theatre — feed it a diff, get back a dramatic ritual reading.

## Status
🌑 Pre-alpha. The oracle is still attuning to the cosmic git stream. See [PLAN.md](./PLAN.md).

## Quick taste (planned UX)
```bash
oracle read https://github.com/you/repo/pull/42
oracle read ./feature.diff --method=runes
gh pr diff 42 | oracle read --method=tarot --json
```

## Install
Not yet. Soon™.

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
```

### Tarot reading (M4)
The `tarot` method draws three Major Arcana cards (Past / Present / Future) seeded by a SHA-256 hash of the diff, so the same diff always yields the same spread. Cards may land upright or reversed, and the renderer flips reversed cards visually in the ASCII spread.

### Runes reading (M5)
The `runes` method casts three Elder Futhark runes (Situation / Obstacle / Outcome) seeded by a different slice of the diff hash. Reversed runes are read as *merkstave* — their warning meaning.

```bash
node dist/cli.js read ./feature.diff --method=runes --offline
```

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
MIT (planned)
