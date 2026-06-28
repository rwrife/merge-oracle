#!/usr/bin/env node
import { Command } from "commander";
import { hello, VERSION } from "./oracle.js";
import { loadDiff } from "./sources/index.js";
import { createLlmClient, MissingApiKeyError } from "./llm/index.js";
import { DEFAULT_METHOD_ID, getMethod, listMethods } from "./methods/_registry.js";
import { runStdioServer } from "./mcp/server.js";
import {
  DEFAULT_BLESS_THRESHOLD,
  assessDiffSeverity,
  installHook,
  readHookStatus,
  uninstallHook,
} from "./bless.js";

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
  .action(async (source: string, opts: { json?: boolean; offline?: boolean; method: string }) => {
    const method = getMethod(opts.method);
    if (!method) {
      console.error(
        `unknown divination method: ${opts.method}. try one of: ${listMethods().map((m) => m.id).join(", ")}`,
      );
      process.exit(2);
      return;
    }
    const loaded = await loadDiff(source);
    const symbols = method.draw(loaded.diff);
    try {
      const client = createLlmClient({ offline: opts.offline });
      const messages = method.readingPrompt(symbols, loaded.diff);
      const reading = await client.complete(messages);
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              source: loaded.source,
              origin: loaded.origin,
              method: method.id,
              channel: client.id,
              symbols,
              reading,
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }
      const art = method.render(symbols);
      process.stdout.write(
        `🔮 ${method.name}\n` +
          `   source: ${loaded.source} (${loaded.origin}, ${loaded.diff.length} bytes)\n` +
          `   channel: ${client.id}\n\n${art}\n\n${reading}\n`,
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
