# merge-oracle 🔮

## 1. Pitch
`merge-oracle` is a mystical CLI that divines the fate of your pull requests. Feed it a PR URL or a raw diff, choose your divination method — tarot, runes, tea leaves, or I-Ching — and a dramatic AI oracle delivers a reading: hidden bugs, reviewer mood, merge probability, and the ancestral karma of your code. Half useful PR review, half theatre.

## 2. Trend inspiration
- AI agents and "personas" wrapping dev workflows are everywhere on HN and r/LocalLLaMA in 2026 (Claude Code, Codex, Gemini CLI dominating the "AI coding agents" showdown — https://worldofsoftware.org/the-2026-ai-coding-tools-showdown-codex-claude-code-cursor-copilot-and-gemini-cli-compared-chat-gpt-ai-hub/).
- TUI/CLI tools with strong personality keep trending in r/commandline and on awesome-cli lists for 2026 (https://github.com/spinov001-art/awesome-cli-tools-2026).
- MCP servers and curated "best-of" lists for them are dominating dev discourse (https://github.com/punkpeye/awesome-mcp-servers, https://septimlabs.com/blog/best-mcp-servers-2026) — there's a strong appetite for small focused agentic tools that plug into existing workflows.
- Product Hunt productivity launches in 2026 lean into delight + utility hybrids (https://www.producthunt.com/categories/productivity).

## 3. Why it's different
- **vs. typical AI PR reviewers** (CodeRabbit, Greptile, etc.): those are corporate, dry, and tell you "consider adding null-check on line 42." `merge-oracle` is theatrical, persona-first, and delivers verdicts as ritual readings — a memorable, shareable artifact you'd actually screenshot.
- **vs. `commit-roast`** (sibling repo, judges individual commit messages): merge-oracle operates at the PR/diff level and uses divination metaphors rather than roast personas.
- **vs. `link-coroner` / `schema-seance` / `regex-rumble`** (sibling repos with themed CLIs): different domain (PRs), different ritual vocabulary (divination, not autopsy/seance/dojo), and a plugin architecture for divination methods.
- The plugin model — drop in a new divination method (numerology, dream interpretation, astrology of the commit author's birthday) as one file — makes it extensible in a way single-persona tools aren't.

## 4. MVP scope (v0.1)
- `oracle read <pr-url-or-path-to-diff>` consumes a GitHub PR (via `gh`) or a local `.diff` file.
- One working divination method: **tarot** — draws 3 cards (Past = base branch karma, Present = the diff itself, Future = merge prophecy).
- LLM-backed reading via env-var-configured provider (OpenAI-compatible endpoint first; pluggable).
- ASCII card art + colorized terminal output.
- `oracle methods` lists available divination methods.
- `--json` flag for machine-readable output (so it can be piped into CI bots later).
- Graceful offline mock mode (`--offline`) returns canned mystical drivel for demos and tests.

## 5. Tech stack
- **Node.js + TypeScript** — fits the existing tool-lab ecosystem, easy to publish via npm, fast to iterate.
- **commander** for the CLI surface — boring, battle-tested.
- **chalk** + **gradient-string** for the mystical vibes.
- **OpenAI SDK** as the default LLM client (works against any OpenAI-compatible endpoint, incl. local LM Studio/Ollama via `OPENAI_BASE_URL`).
- **vitest** for tests.
- **gh CLI** as a subprocess for PR fetching (no GitHub API auth code to write).

Justification: smallest surface, fastest "v0.1 in a day" path, easy to extend with plugins as plain TS files in `src/methods/`.

## 6. Architecture
```
src/
  cli.ts              # commander entry point
  oracle.ts           # core: load source -> pick method -> render
  sources/
    github.ts         # `gh pr view` + `gh pr diff` wrappers
    file.ts           # read .diff/.patch from disk
    stdin.ts          # pipe support
  methods/
    tarot.ts          # MVP method
    _registry.ts      # method discovery
  llm/
    client.ts         # OpenAI-compatible client + offline mock
    prompts.ts        # reusable prompt fragments
  render/
    ascii.ts          # card / rune / cup ASCII art
    colors.ts         # chalk wrappers
```
A "divination method" is just: `{ id, name, describe(), draw(diff) -> symbols[], readingPrompt(symbols, diff) -> messages[] }`. Adding a new one = drop a file in `src/methods/` and the registry picks it up.

## 7. Milestones
1. **M1 — scaffold + hello-world**: TS project, commander entry, `oracle --version`, `oracle hello`, vitest configured, CI workflow that runs `npm test` and `npm run build`.
2. **M2 — source loaders**: `gh` PR loader, file loader, stdin loader, with unit tests against fixture diffs.
3. **M3 — LLM client + offline mock**: configurable OpenAI-compatible client, `--offline` fixture mode, prompt assembly tested with snapshots.
4. **M4 — tarot method (MVP reading)**: 22-card major-arcana deck JSON, 3-card draw seeded by diff hash for reproducibility, full end-to-end reading rendered with ASCII art.
5. **M5 — `methods` command + plugin registry**: auto-discovery of methods, `oracle read --method=<id>`, second method (**runes**) shipped to prove plugin model.
6. **M6 — polish + release**: `--json` output, README with GIF, npm publish (scoped `@rwrife/merge-oracle`), GitHub release with binary via `pkg` or `bun build --compile`.

## 8. Backlog / future features
1. **Tea leaves** divination method — interprets the "shape" of the diff stats.
2. **I-Ching** method — hashes the diff into a hexagram and reads the changing lines.
3. **Astrology mode** — uses commit author's birthday (from local git config) for natal-chart-flavored readings.
4. **`oracle watch`** — daemon that posts a reading as a PR comment whenever a PR is opened (gh webhook or Action).
5. **Multi-card spreads** — Celtic Cross spread for "important" PRs (>500 LoC).
6. **MCP server mode** — expose `oracle.read` as an MCP tool so Claude/Cursor can summon readings inline.
7. **GitHub Action** — `rwrife/merge-oracle@v1` posts readings on PR open.
8. **Reading history** — local SQLite of past readings, `oracle history <repo>` to see if the cards were right.
9. **Reviewer mood predictor** — fine-tunes prophecy on past review tone of named reviewers.
10. **Custom decks** — users supply their own deck JSON (Marseille, Thoth, custom company-themed).
11. **Shareable card images** — render readings as PNGs via satori/sharp for tweets.
12. **Cursed mode** — locks down the repo (a `git hook`) until you've consulted the oracle. Pure theatre.

## 9. Out of scope
- Actually being a serious PR review tool (CodeRabbit/Greptile own that).
- Web UI for v0.1 (CLI-only; web is post-1.0 territory).
- Hosting our own model — always BYO endpoint.
- Multi-repo dashboards / SaaS subscription tiers.
- Predicting lottery numbers from commit hashes. (Tempting. No.)
