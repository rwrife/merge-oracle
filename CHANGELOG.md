# Changelog

All notable changes to `@rwrife/merge-oracle` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
