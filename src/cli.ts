#!/usr/bin/env node
import { Command } from "commander";
import { hello, VERSION } from "./oracle.js";

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

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
