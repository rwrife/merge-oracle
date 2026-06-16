import { githubLoader } from "./github.js";
import { fileLoader } from "./file.js";
import { stdinLoader } from "./stdin.js";
import type { DiffLoader, LoadedDiff } from "./types.js";

export type { DiffLoader, LoadedDiff } from "./types.js";
export { githubLoader, fileLoader, stdinLoader };

/**
 * Loader order matters: stdin (`-`) and GitHub URLs are tried before file,
 * since file's matcher is the broadest fallback.
 */
export const defaultLoaders: DiffLoader[] = [stdinLoader, githubLoader, fileLoader];

export function pickLoader(locator: string, loaders: DiffLoader[] = defaultLoaders): DiffLoader {
  const hit = loaders.find((l) => l.matches(locator));
  if (!hit) {
    throw new Error(`no loader matched: ${locator}`);
  }
  return hit;
}

export async function loadDiff(
  locator: string,
  loaders: DiffLoader[] = defaultLoaders,
): Promise<LoadedDiff> {
  return pickLoader(locator, loaders).load(locator);
}
