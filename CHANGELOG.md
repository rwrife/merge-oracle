# Changelog

All notable changes to `@rwrife/merge-oracle` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Custom decks: `oracle read --deck=<id-or-path>` accepts a bundled deck id, an id registered via `$MERGE_ORACLE_DECKS_DIR`, or a direct path to a deck JSON file. Ships v1 deck schema (`docs/deck.schema.json`), a deck registry that discovers bundled + env-provided decks, per-method card validation for `tarot` and `runes`, a new `oracle decks` command with `--json` and `--method` filters, and example decks under `examples/decks/`. All bundled decks are re-wrapped into the new envelope format. (#35)
- `astrology` divination method: casts a three-sign natal chart for the PR — **Sun** from the diff's creation timestamp (`Date:` header when present, hash-synthesized otherwise), **Moon** from the author's birthday (`git config user.birthday`, `YYYY-MM-DD` or `MM-DD`; synthesized deterministically when absent), and **Rising** from the base branch + repo name. Element, modality, and ruling planet are woven into the reading; synthesized natal dates are disclosed in a `— chart cast from synthesized natal date` footer. Ships a 12-sign zodiac deck under `src/data/decks/zodiac.json`. (#34)
- Shareable reading cards: `oracle read --png=<path>` renders the reading as a 1200x630 PNG via satori + sharp, with `--png-theme=dark|light|parchment` and `--png-size=WxH` (bounded 200–4096). `--png=-` streams PNG bytes to stdout. Ships a bundled Inter (OFL) font under `src/data/fonts/` so rendering works fully offline. (#30)
- GitHub Action: composite `rwrife/merge-oracle@v1` action that installs the CLI, fetches the PR diff via `gh`, runs `oracle read`, and posts the reading as a **sticky** PR comment (updated in place on every push). Configurable `method`, `offline`, `version`, and OpenAI env passthrough. Example workflow shipped under `examples/workflow.yml`. (#10)
- MCP server mode: `oracle mcp` runs a stdio MCP server exposing `oracle.read` and `oracle.methods` as tools so Claude/Cursor/Codex can summon readings inline. (#9)
- `i-ching` divination method: hashes the diff into a six-line hexagram cast under traditional yarrow-stalk probabilities; changing lines transform a Primary hexagram into a Derived one, read as the merge prophecy. (#8)
- `tea-leaves` divination method: parses diff structure (files, +/-, hunks, dirs) and reads three shapes from the cup as Rim / Side / Bottom. (#7)
- `LICENSE` file (MIT).
- `CHANGELOG.md` tracking notable changes.
- Publishing metadata in `package.json` (`keywords`, `author`, `homepage`, `bugs`, `publishConfig`).
- GitHub Actions release workflow that publishes to npm on `v*` tag pushes.

## [0.0.1] - 2026-06-14

### Added
- Initial scaffold: TypeScript + commander + vitest.
- `oracle hello` and `oracle --version`.
- Source loaders: GitHub PR URL (via `gh`), local `.diff`/`.patch` files, stdin.
- OpenAI-compatible LLM client with `--offline` mock mode.
- `tarot` divination method (3-card Major Arcana spread, diff-hash seeded).
- `runes` divination method (3-rune Elder Futhark cast, merkstave on reverse).
- `oracle methods` command with `--json` output.
- `oracle read` with `--json`, `--offline`, and `--method` flags.
- CI workflow running `npm ci && npm run build && npm test`.
