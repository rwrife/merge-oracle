import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { DiffLoader, LoadedDiff } from "./types.js";

const DIFF_EXT = /\.(diff|patch)$/i;

export const fileLoader: DiffLoader = {
  id: "file",
  matches(locator: string): boolean {
    // Anything that isn't a URL, isn't stdin (`-`), and looks pathish.
    if (locator === "-" || locator === "") return false;
    if (/^https?:\/\//i.test(locator)) return false;
    return true;
  },
  async load(locator: string): Promise<LoadedDiff> {
    const path = resolve(locator);
    const s = await stat(path);
    if (!s.isFile()) {
      throw new Error(`not a file: ${path}`);
    }
    const diff = await readFile(path, "utf8");
    return {
      source: "file",
      origin: path,
      diff,
      meta: {
        bytes: s.size,
        looksLikeDiff: DIFF_EXT.test(path) || /^diff --git /m.test(diff),
      },
    };
  },
};
