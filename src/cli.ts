#!/usr/bin/env node
import { Command } from "commander";
import { hello, VERSION } from "./oracle.js";
import { loadDiff } from "./sources/index.js";
import { createLlmClient, MissingApiKeyError } from "./llm/index.js";
import { DEFAULT_METHOD_ID, getMethod, listMethods } from "./methods/_registry.js";
import { runStdioServer } from "./mcp/server.js";

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
  .command("mcp")
  .description("run as an MCP server over stdio (newline-delimited JSON-RPC)")
  .action(async () => {
    await runStdioServer();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
