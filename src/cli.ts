#!/usr/bin/env node
import { Command } from "commander";
import { hello, VERSION } from "./oracle.js";
import { loadDiff } from "./sources/index.js";
import { assembleReadingPrompt, createLlmClient, MissingApiKeyError } from "./llm/index.js";

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
  .option("--json", "emit the loaded diff envelope as JSON")
  .option("--offline", "skip the LLM and return canned mystical drivel")
  .action(async (source: string, opts: { json?: boolean; offline?: boolean }) => {
    const loaded = await loadDiff(source);
    if (opts.json) {
      process.stdout.write(JSON.stringify(loaded, null, 2) + "\n");
      return;
    }
    try {
      const client = createLlmClient({ offline: opts.offline });
      const messages = assembleReadingPrompt({
        methodName: "placeholder (M4 brings tarot)",
        symbols: [],
        diff: loaded.diff,
      });
      const reading = await client.complete(messages);
      process.stdout.write(
        `🔮 the oracle has received ${loaded.diff.length} bytes from ${loaded.source} (${loaded.origin}).\n` +
          `   (channel: ${client.id})\n\n${reading}\n`,
      );
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        console.error(err.message);
        process.exit(2);
      }
      throw err;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
