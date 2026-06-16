#!/usr/bin/env node
import { Command } from "commander";
import { hello, VERSION } from "./oracle.js";
import { loadDiff } from "./sources/index.js";

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
  .action(async (source: string, opts: { json?: boolean }) => {
    const loaded = await loadDiff(source);
    if (opts.json) {
      process.stdout.write(JSON.stringify(loaded, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      `🔮 the oracle has received ${loaded.diff.length} bytes from ${loaded.source} (${loaded.origin}).\n` +
        `   (divination methods arrive in a later milestone)\n`,
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
