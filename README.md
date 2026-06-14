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
```

CI runs `npm ci && npm run build && npm test` on every push and PR (see `.github/workflows/ci.yml`).

## License
MIT (planned)
