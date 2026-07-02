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
    const { spread, autoUpgraded } = resolveSpreadSelection({
      supportedSpreads: method.supportedSpreads,
      requested: opts.spread,
      diff: loaded.diff,
      threshold,
    });
    const callOpts = spread ? { spread } : undefined;
    const symbols = method.draw(loaded.diff, callOpts);
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
              diffLoc: countDiffLoc(loaded.diff),
              bigPrThreshold: threshold,
              symbols,
              reading,
              historyId,
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
      const historyLabel = historyId != null ? `   history: #${historyId}\n` : "";
      process.stdout.write(
        `🔮 ${method.name}\n` +
          `   source: ${loaded.source} (${loaded.origin}, ${loaded.diff.length} bytes)\n` +
          spreadLabel +
          `   persona: ${persona.name}\n` +
          `   channel: ${client.id}\n` +
          historyLabel +
          `\n${art}\n\n${reading}\n`,
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
