# Changelog

All notable changes to `@rwrife/merge-oracle` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `oracle chronicle` command: composes a meta-reading across a batch of past readings pulled from the local history DB. Supports mutually-exclusive selectors (`--last=<n>`, `--since` / `--until`, `--milestone=<name>` via `gh api search/issues`, or `--all`), optional `--repo=<owner/name>` scoping, `--persona=<id>` narration, and configurable top-omens (`--top-omens=<n>`, default 3). Aggregates method / persona / outcome tallies, recurring symbols across any divination method (tarot cards, runes, hexagrams, tea shapes, natal signs, life-path numbers), and — when reviewer signal is present — a warming/mixed/cooling team-weather roll-up. Emits a rendered five-section chronicle (Gathering / Omens / Weather / Chronicle / Prophecy) or a full `--json` blob with `chronicle.selection`, `chronicle.omens[]`, `chronicle.weather`, `chronicle.narrative`, and `chronicle.prophecy` for downstream bots. `--offline` returns a deterministic canned narrative that still consumes the real aggregates so the shape stays honest, and the command emits a friendly one-liner (exit 0) when the selection matches zero readings. (#40)
- Reviewer mood predictor: `oracle read --with-reviewer-mood[=logins]` folds each reviewer's recent history on the target repo into the prophecy. Cheap local heuristics only (approval/change-request/comment ratios, mean rounds, top-3 comment keywords, nitpick rate) shape a compact JSON blob spliced into the LLM prompt and rendered as a new `🌗 Reviewer weather` section (also surfaced under `reading.sections.reviewerMood[]` in `--json`). Auto-detects reviewers from the PR when no explicit list is given, caches per-reviewer aggregates in the shared history DB (`reviewer_mood` table, 24h TTL), and degrades gracefully to "insufficient signal" or canned `--offline` moods when `gh`/network is unavailable. Ships `--refresh-reviewer-mood` and `--reviewer-mood-limit=<n>` (default 20, max 100) knobs plus a `with-reviewer-mood` boolean input on the GitHub Action. Zero effect on API calls or prompt tokens when the flag is omitted. (#36)
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
