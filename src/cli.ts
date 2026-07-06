#!/usr/bin/env node
import { Command } from "commander";
import { hello, VERSION } from "./oracle.js";
import { loadDiff } from "./sources/index.js";
import { createLlmClient, MissingApiKeyError } from "./llm/index.js";
import { DEFAULT_METHOD_ID, getMethod, listMethods } from "./methods/_registry.js";
import {
  DEFAULT_PERSONA_ID,
  getPersona,
  listPersonas,
  resolvePersona,
} from "./personas/_registry.js";
import { createOfflineClient } from "./llm/client.js";
import { runStdioServer } from "./mcp/server.js";
import {
  DECKS_DIR_ENV,
  describeDeckSource,
  listDecks,
  resolveDeck,
} from "./data/decks/_registry.js";
import { DeckValidationError } from "./data/decks/types.js";
import {
  DEFAULT_BLESS_THRESHOLD,
  assessDiffSeverity,
  installHook,
  readHookStatus,
  uninstallHook,
} from "./bless.js";
import { DEFAULT_BIG_PR_THRESHOLD, countDiffLoc, resolveSpread as resolveSpreadSelection } from "./spreads.js";
import {
  HistoryStore,
  historyEnabledFromEnv,
  renderHistoryDetail,
  renderHistoryTable,
  type Outcome,
} from "./history.js";
import {
  DEFAULT_PNG_THEME,
  PNG_THEMES,
  isPngTheme,
  parsePngSize,
  renderCardPng,
  type PngThemeId,
} from "./render/png.js";
import {
  DEFAULT_REVIEWER_MOOD_LIMIT,
  MAX_REVIEWER_MOOD_LIMIT,
  collectReviewerMood,
  extractReviewersFromPrView,
  parseReviewerList,
  renderReviewerMoodSection,
  reviewerMoodJsonSection,
  reviewerMoodPromptFragment,
} from "./reviewers/history.js";
import { parsePrOrigin } from "./history.js";
import { writeFileSync } from "node:fs";

const program = new Command();

program
  .name("oracle")
  .description("A mystical CLI oracle that divines the fate of your pull requests.")
  .version(VERSION, "-v, --version", "show the oracle's incantation version");

program
  .command("hello")
  .description("a small offering to test that the oracle is listening")
  .option("-n, --name <name>", "who seeks the oracle", "seeker")
  .action((opts: { name: string }) => {
    process.stdout.write(hello(opts.name) + "\n");
  });

program
  .command("read")
  .description("load a diff from a GitHub PR URL, a file, or '-' for stdin")
  .argument("<source>", "PR URL, path to .diff/.patch, or '-' for stdin")
  .option("--json", "emit the reading as JSON instead of rendered text")
  .option("--offline", "skip the LLM and return canned mystical drivel")
  .option("--method <id>", "divination method id", DEFAULT_METHOD_ID)
  .option("--persona <id>", "narrator persona id (see `oracle personas`)")
  .option("--spread <id>", "force a specific spread (e.g. three-card, celtic-cross)")
  .option(
    "--big-pr-threshold <n>",
    "LoC changed at which methods auto-upgrade to a richer spread",
    String(
      Number.parseInt(process.env.ORACLE_BIG_PR_THRESHOLD ?? "", 10) || DEFAULT_BIG_PR_THRESHOLD,
    ),
  )
  .option("--no-history", "do not persist this reading to the local history db")
  .option(
    "--png <path>",
    "also write the reading as a shareable PNG card to <path> (use '-' for stdout)",
  )
  .option(
    "--png-theme <id>",
    `PNG theme: ${PNG_THEMES.join("|")}`,
    DEFAULT_PNG_THEME,
  )
  .option(
    "--png-size <WxH>",
    "PNG dimensions, e.g. 1200x630 (default) or 1600x840",
  )
  .option(
    "--deck <id-or-path>",
    "deck id (see `oracle decks`) or path to a deck JSON file (methods that support alternate decks only)",
  )
  .option(
    "--with-reviewer-mood [logins]",
    "fold reviewer history into the prompt; optional comma-separated logins (default: auto-detect from PR)",
  )
  .option("--refresh-reviewer-mood", "ignore the SQLite cache and re-fetch reviewer history")
  .option(
    "--reviewer-mood-limit <n>",
    `closed PRs to scan per reviewer (max ${MAX_REVIEWER_MOOD_LIMIT})`,
    String(DEFAULT_REVIEWER_MOOD_LIMIT),
  )
  .action(
    async (
      source: string,
      opts: {
        json?: boolean;
        offline?: boolean;
        method: string;
        persona?: string;
        spread?: string;
        bigPrThreshold: string;
        history?: boolean;
        png?: string;
        pngTheme: string;
        pngSize?: string;
        deck?: string;
        withReviewerMood?: string | boolean;
        refreshReviewerMood?: boolean;
        reviewerMoodLimit: string;
      },
    ) => {
    const method = getMethod(opts.method);
    if (!method) {
      console.error(
        `unknown divination method: ${opts.method}. try one of: ${listMethods().map((m) => m.id).join(", ")}`,
      );
      process.exit(2);
      return;
    }
    if (opts.persona && !getPersona(opts.persona)) {
      console.error(
        `unknown persona: ${opts.persona}. try one of: ${listPersonas().map((p) => p.id).join(", ")}`,
      );
      process.exit(2);
      return;
    }
    const persona = resolvePersona(opts.persona) ?? resolvePersona(DEFAULT_PERSONA_ID)!;
    const loaded = await loadDiff(source);
    const threshold = Number.parseInt(opts.bigPrThreshold, 10);
    if (!Number.isFinite(threshold) || threshold < 0) {
      console.error("--big-pr-threshold must be a non-negative integer");
      process.exit(2);
      return;
    }
    // Validate PNG flags early so we don't burn an LLM call on a typo.
    let pngSize: { width: number; height: number } | undefined;
    if (opts.png != null) {
      if (!isPngTheme(opts.pngTheme)) {
        console.error(
          `unknown --png-theme: ${opts.pngTheme}. try one of: ${PNG_THEMES.join(", ")}`,
        );
        process.exit(2);
        return;
      }
      if (opts.pngSize) {
        try {
          pngSize = parsePngSize(opts.pngSize);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
          return;
        }
      }
    }
    if (opts.spread && method.supportedSpreads) {
      const ids = method.supportedSpreads.map((s) => s.id);
      if (!ids.includes(opts.spread)) {
        console.error(
          `unknown spread for method '${method.id}': ${opts.spread}. try one of: ${ids.join(", ")}`,
        );
        process.exit(2);
        return;
      }
    } else if (opts.spread && !method.supportedSpreads) {
      console.error(`method '${method.id}' does not support alternate spreads`);
      process.exit(2);
      return;
    }
    let deck: ReturnType<typeof resolveDeck> | undefined;
    if (opts.deck) {
      try {
        deck = resolveDeck(opts.deck, method.id);
      } catch (err) {
        console.error(
          err instanceof DeckValidationError ? err.message : (err as Error).message,
        );
        process.exit(2);
        return;
      }
    }
    const { spread, autoUpgraded } = resolveSpreadSelection({
      supportedSpreads: method.supportedSpreads,
      requested: opts.spread,
      diff: loaded.diff,
      threshold,
    });
    const callOpts = spread || deck ? { spread, deck } : undefined;
    const symbols = method.draw(loaded.diff, callOpts);

    // ---------- Reviewer mood (issue #36) ----------
    // Flag was omitted entirely: zero effect on prompt, JSON, or network.
    const moodRequested = opts.withReviewerMood !== undefined;
    let reviewerMoodBlob: Awaited<ReturnType<typeof collectReviewerMood>> | null = null;
    if (moodRequested) {
      const moodLimit = Number.parseInt(opts.reviewerMoodLimit, 10);
      if (!Number.isFinite(moodLimit) || moodLimit <= 0 || moodLimit > MAX_REVIEWER_MOOD_LIMIT) {
        console.error(
          `--reviewer-mood-limit must be a positive integer <= ${MAX_REVIEWER_MOOD_LIMIT}`,
        );
        process.exit(2);
        return;
      }
      const explicit = parseReviewerList(opts.withReviewerMood);
      const autoDetected = extractReviewersFromPrView(loaded.meta);
      const reviewers = explicit.length > 0 ? explicit : autoDetected;
      const { repo } = parsePrOrigin(loaded.origin);
      if (reviewers.length === 0) {
        // Render an empty, honest section rather than pretending.
        reviewerMoodBlob = {
          fetchedAt: new Date().toISOString(),
          ttlMs: 0,
          limit: moodLimit,
          offline: opts.offline === true,
          reviewers: [],
        };
      } else {
        try {
          reviewerMoodBlob = await collectReviewerMood({
            repo,
            reviewers,
            limit: moodLimit,
            offline: opts.offline === true || repo == null,
            refresh: opts.refreshReviewerMood === true,
          });
        } catch (err) {
          // Never fail a reading over the mood section.
          process.stderr.write(`⚠ reviewer-mood: ${(err as Error).message}\n`);
          reviewerMoodBlob = {
            fetchedAt: new Date().toISOString(),
            ttlMs: 0,
            limit: moodLimit,
            offline: true,
            reviewers: reviewers.map((login) => ({
              login,
              tone: "unknown" as const,
              approvals: 0,
              changesRequested: 0,
              commented: 0,
              dismissed: 0,
              meanRounds: 0,
              nitpickRate: 0,
              topKeywords: [],
              totalReviews: 0,
              summary: `@${login} — insufficient signal (${(err as Error).message || "lookup failed"}).`,
              insufficient: true,
              offline: false,
            })),
          };
        }
      }
    }
    try {
      const client = opts.offline
        ? createOfflineClient(persona.offlineLines(symbols))
        : createLlmClient({ offline: opts.offline });
      let messages = method.readingPrompt(symbols, loaded.diff, callOpts);
      if (persona.systemPrompt.trim()) {
        messages = [
          ...messages,
          { role: "system", content: `Persona — ${persona.name}: ${persona.systemPrompt}` },
        ];
      }
      // Reviewer-mood fragment rides in as an extra system message so it
      // biases the reading without polluting the base method prompt.
      if (reviewerMoodBlob && reviewerMoodBlob.reviewers.length > 0) {
        const fragment = reviewerMoodPromptFragment(reviewerMoodBlob);
        if (fragment) messages = [...messages, { role: "system", content: fragment }];
      }
      const reading = await client.complete(messages);
      let historyId: number | null = null;
      const wantHistory = opts.history !== false && historyEnabledFromEnv();
      if (wantHistory) {
        try {
          const store = new HistoryStore();
          const row = store.insert({
            loaded,
            methodId: method.id,
            personaId: persona.id,
            spread: spread ?? null,
            symbols,
            reading,
            channel: client.id,
          });
          historyId = row.id;
          store.close();
        } catch (err) {
          // History is best-effort; never block a reading on it.
          process.stderr.write(`⚠ history: ${(err as Error).message}\n`);
        }
      }
      // Optional PNG export happens after the reading is finalized but before
      // we emit text/JSON, so we can echo the resulting path into --json output.
      let pngResult: { path: string; theme: string; width: number; height: number } | null = null;
      if (opts.png != null) {
        const card = {
          methodName: method.name,
          personaName: persona.name,
          spread: spread ?? null,
          symbols,
          reading,
          diff: loaded.diff,
          repoRef:
            loaded.source === "github"
              ? loaded.origin
              : loaded.source === "file"
                ? loaded.origin
                : "stdin",
          channel: client.id,
        };
        const rendered = await renderCardPng(card, {
          theme: opts.pngTheme as PngThemeId,
          width: pngSize?.width,
          height: pngSize?.height,
        });
        if (opts.png === "-") {
          process.stdout.write(rendered.buffer);
          pngResult = {
            path: "-",
            theme: rendered.theme,
            width: rendered.width,
            height: rendered.height,
          };
        } else {
          writeFileSync(opts.png, rendered.buffer);
          pngResult = {
            path: opts.png,
            theme: rendered.theme,
            width: rendered.width,
            height: rendered.height,
          };
        }
      }
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              source: loaded.source,
              origin: loaded.origin,
              method: method.id,
              persona: persona.id,
              channel: client.id,
              spread: spread ?? null,
              spreadAutoUpgraded: autoUpgraded,
              deck: deck
                ? { id: deck.id, name: deck.name, source: deck.source, sourcePath: deck.sourcePath }
                : null,
              diffLoc: countDiffLoc(loaded.diff),
              bigPrThreshold: threshold,
              symbols,
              reading: reviewerMoodBlob
                ? {
                    text: reading,
                    sections: {
                      reviewerMood: reviewerMoodJsonSection(reviewerMoodBlob),
                    },
                  }
                : reading,
              historyId,
              png: pngResult,
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }
      const art = method.render(symbols, callOpts);
      const spreadLabel = spread
        ? `   spread: ${spread}${autoUpgraded ? " (auto-upgraded: big PR)" : ""}\n`
        : "";
      const deckLabel = deck ? `   deck: ${deck.id} (${describeDeckSource(deck)})\n` : "";
      const historyLabel = historyId != null ? `   history: #${historyId}\n` : "";
      const pngLabel =
        pngResult && pngResult.path !== "-"
          ? `   png: ${pngResult.path} (${pngResult.width}x${pngResult.height}, ${pngResult.theme})\n`
          : "";
      // When --png=-, the PNG bytes were already written to stdout; skip the text card.
      if (pngResult && pngResult.path === "-") return;
      const moodTail =
        reviewerMoodBlob && reviewerMoodBlob.reviewers.length > 0
          ? `\n${renderReviewerMoodSection(reviewerMoodBlob)}`
          : "";
      process.stdout.write(
        `🔮 ${method.name}\n` +
          `   source: ${loaded.source} (${loaded.origin}, ${loaded.diff.length} bytes)\n` +
          spreadLabel +
          deckLabel +
          `   persona: ${persona.name}\n` +
          `   channel: ${client.id}\n` +
          historyLabel +
          pngLabel +
          `\n${art}\n\n${reading}\n${moodTail}`,
      );
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        console.error(err.message);
        process.exit(2);
      }
      throw err;
    }
  });

program
  .command("methods")
  .description("list available divination methods")
  .option("--json", "emit the method list as JSON instead of rendered text")
  .action((opts: { json?: boolean }) => {
    const methods = listMethods();
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            default: DEFAULT_METHOD_ID,
            methods: methods.map((m) => ({
              id: m.id,
              name: m.name,
              description: m.describe(),
              default: m.id === DEFAULT_METHOD_ID,
              supportedSpreads: m.supportedSpreads
                ? m.supportedSpreads.map((s) => ({
                    id: s.id,
                    name: s.name,
                    cards: s.cards,
                    default: s.default === true,
                  }))
                : [],
            })),
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    if (methods.length === 0) {
      process.stdout.write("no divination methods registered — the veil is empty.\n");
      return;
    }
    for (const m of methods) {
      const marker = m.id === DEFAULT_METHOD_ID ? "*" : " ";
      process.stdout.write(`${marker} ${m.id.padEnd(12)} ${m.name}\n      ${m.describe()}\n`);
    }
  });

program
  .command("decks")
  .description("list registered decks (bundled + $MERGE_ORACLE_DECKS_DIR)")
  .option("--method <id>", "filter by divination method id")
  .option("--json", "emit the deck list as JSON instead of rendered text")
  .action((opts: { method?: string; json?: boolean }) => {
    const decks = listDecks(opts.method);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            env: DECKS_DIR_ENV,
            envDir: process.env[DECKS_DIR_ENV] ?? null,
            filter: opts.method ?? null,
            decks: decks.map((d) => ({
              id: d.id,
              name: d.name,
              method: d.method,
              version: d.version,
              cards: d.cards.length,
              source: d.source,
              sourceLabel: describeDeckSource(d),
              sourcePath: d.sourcePath,
            })),
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    if (decks.length === 0) {
      const scope = opts.method ? ` for method '${opts.method}'` : "";
      process.stdout.write(`no decks registered${scope} — the archive is bare.\n`);
      return;
    }
    for (const d of decks) {
      process.stdout.write(
        `  ${d.id.padEnd(20)} ${d.method.padEnd(12)} ${d.cards.length.toString().padStart(3)} cards  ${describeDeckSource(d).padEnd(24)} ${d.name}\n`,
      );
    }
  });

program
  .command("personas")
  .description("list available narrator personas")
  .option("--json", "emit the persona list as JSON instead of rendered text")
  .action((opts: { json?: boolean }) => {
    const personas = listPersonas();
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            default: DEFAULT_PERSONA_ID,
            personas: personas.map((p) => ({
              id: p.id,
              name: p.name,
              description: p.describe(),
              default: p.id === DEFAULT_PERSONA_ID,
            })),
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    if (personas.length === 0) {
      process.stdout.write("no personas registered — the oracle has lost its voice.\n");
      return;
    }
    for (const p of personas) {
      const marker = p.id === DEFAULT_PERSONA_ID ? "*" : " ";
      process.stdout.write(`${marker} ${p.id.padEnd(18)} ${p.name}\n      ${p.describe()}\n`);
    }
  });

program
  .command("bless")
  .description("install/manage a pre-push git hook that consults the oracle before each push")
  .option("--install", "install the pre-push hook in the current repo")
  .option("--uninstall", "remove the oracle-managed pre-push hook")
  .option("--status", "report whether the hook is installed")
  .option("--force", "overwrite a foreign pre-push hook (with --install or --uninstall)")
  .option("--check <source>", "assess a diff (path or '-') and exit non-zero when severity >= threshold")
  .option("--threshold <n>", "severity threshold for --check / installed hook", String(DEFAULT_BLESS_THRESHOLD))
  .option("--json", "emit results as JSON")
  .action(async (opts: {
    install?: boolean;
    uninstall?: boolean;
    status?: boolean;
    force?: boolean;
    check?: string;
    threshold: string;
    json?: boolean;
  }) => {
    const threshold = Number.parseInt(opts.threshold, 10);
    if (Number.isNaN(threshold) || threshold < 0 || threshold > 10) {
      console.error("--threshold must be an integer in [0, 10]");
      process.exit(2);
      return;
    }
    const modes = [opts.install, opts.uninstall, opts.status, opts.check != null].filter(Boolean).length;
    if (modes === 0) {
      console.error("oracle bless: pick one of --install, --uninstall, --status, or --check <source>");
      process.exit(2);
      return;
    }
    if (modes > 1) {
      console.error("oracle bless: --install, --uninstall, --status, and --check are mutually exclusive");
      process.exit(2);
      return;
    }
    if (opts.status) {
      const st = readHookStatus();
      if (opts.json) {
        process.stdout.write(JSON.stringify(st, null, 2) + "\n");
      } else {
        const label =
          st.kind === "installed"
            ? "🔮 oracle bless is installed"
            : st.kind === "foreign-hook"
              ? "⚠ a non-oracle pre-push hook is present"
              : "○ oracle bless is not installed";
        process.stdout.write(`${label}\n   ${st.path}\n`);
      }
      return;
    }
    if (opts.install) {
      const res = installHook({ force: opts.force, threshold });
      if (opts.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      else if (res.action === "refused") {
        console.error(`refused: ${res.reason}`);
        process.exit(2);
      } else {
        process.stdout.write(`🔮 oracle bless ${res.action}\n   ${res.path}\n   threshold: ${threshold}\n`);
      }
      return;
    }
    if (opts.uninstall) {
      const res = uninstallHook({ force: opts.force });
      if (opts.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      else if (res.action === "refused") {
        console.error(`refused: ${res.reason}`);
        process.exit(2);
      } else if (res.action === "absent") {
        process.stdout.write(`○ no pre-push hook to remove (${res.path})\n`);
      } else {
        process.stdout.write(`✓ removed ${res.path}\n`);
      }
      return;
    }
    if (opts.check != null) {
      const loaded = await loadDiff(opts.check);
      const verdict = assessDiffSeverity(loaded.diff);
      if (opts.json) {
        process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
      } else if (verdict.severity === 0) {
        process.stdout.write(`🔮 oracle bless: no ill omens (severity 0/10).\n`);
      } else {
        const stream = verdict.severity >= threshold ? process.stderr : process.stdout;
        stream.write(`🔮 oracle bless: severity ${verdict.severity}/10 (threshold ${threshold})\n${verdict.summary}\n`);
      }
      if (verdict.severity >= threshold) process.exit(1);
      return;
    }
  });

const history = program.command("history").description("inspect past oracle readings stored locally");

history
  .command("list", { isDefault: true })
  .description("list recent readings")
  .option("--repo <owner/name>", "filter by repo")
  .option("--method <id>", "filter by divination method")
  .option("--persona <id>", "filter by persona")
  .option("--limit <n>", "max rows to return", "20")
  .option("--json", "emit as JSON")
  .action((opts: { repo?: string; method?: string; persona?: string; limit: string; json?: boolean }) => {
    const limit = Number.parseInt(opts.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error("--limit must be a positive integer");
      process.exit(2);
      return;
    }
    const store = new HistoryStore();
    const rows = store.list({ repo: opts.repo, methodId: opts.method, personaId: opts.persona, limit });
    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else {
      process.stdout.write(renderHistoryTable(rows));
    }
    store.close();
  });

history
  .command("show")
  .description("show the full rendered reading for a given id")
  .argument("<id>", "reading id")
  .option("--json", "emit as JSON")
  .action((id: string, opts: { json?: boolean }) => {
    const n = Number.parseInt(id, 10);
    if (!Number.isFinite(n) || n <= 0) {
      console.error("id must be a positive integer");
      process.exit(2);
      return;
    }
    const store = new HistoryStore();
    const row = store.get(n);
    if (!row) {
      console.error(`no reading #${n}`);
      store.close();
      process.exit(1);
      return;
    }
    if (opts.json) process.stdout.write(JSON.stringify(row, null, 2) + "\n");
    else process.stdout.write(renderHistoryDetail(row));
    store.close();
  });

history
  .command("stats")
  .description("summarize accuracy across methods and personas")
  .option("--json", "emit as JSON")
  .action((opts: { json?: boolean }) => {
    const store = new HistoryStore();
    const s = store.stats();
    if (opts.json) {
      process.stdout.write(JSON.stringify(s, null, 2) + "\n");
      store.close();
      return;
    }
    const lines: string[] = [];
    lines.push(`total readings: ${s.total}`);
    lines.push(`by outcome: ${Object.entries(s.byOutcome).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`);
    lines.push("by method:");
    for (const m of s.byMethod) {
      lines.push(`  ${m.methodId.padEnd(12)} total=${m.total} merged=${m.merged} closed=${m.closed} abandoned=${m.abandoned} pending=${m.pending}`);
    }
    lines.push("by persona:");
    for (const p of s.byPersona) {
      lines.push(`  ${p.personaId.padEnd(18)} total=${p.total} merged=${p.merged} closed=${p.closed} abandoned=${p.abandoned} pending=${p.pending}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
    store.close();
  });

program
  .command("verdict")
  .description("annotate a reading with its real-world outcome")
  .argument("<id>", "reading id")
  .option("--merged", "the PR was merged")
  .option("--closed", "the PR was closed unmerged")
  .option("--abandoned", "the branch was abandoned")
  .option("--json", "emit as JSON")
  .action((id: string, opts: { merged?: boolean; closed?: boolean; abandoned?: boolean; json?: boolean }) => {
    const n = Number.parseInt(id, 10);
    if (!Number.isFinite(n) || n <= 0) {
      console.error("id must be a positive integer");
      process.exit(2);
      return;
    }
    const flags = [opts.merged, opts.closed, opts.abandoned].filter(Boolean).length;
    if (flags !== 1) {
      console.error("pick exactly one of --merged, --closed, --abandoned");
      process.exit(2);
      return;
    }
    const outcome: Outcome = opts.merged ? "merged" : opts.closed ? "closed" : "abandoned";
    const store = new HistoryStore();
    const row = store.setOutcome(n, outcome);
    if (!row) {
      console.error(`no reading #${n}`);
      store.close();
      process.exit(1);
      return;
    }
    if (opts.json) process.stdout.write(JSON.stringify(row, null, 2) + "\n");
    else process.stdout.write(`✓ reading #${row.id} marked as ${row.outcome} (at ${row.outcomeAt})\n`);
    store.close();
  });

program
  .command("mcp")
  .description("run as an MCP server over stdio (newline-delimited JSON-RPC)")
  .action(async () => {
    await runStdioServer();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
