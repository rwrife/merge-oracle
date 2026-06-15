import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffLoader, LoadedDiff } from "./types.js";

const pexec = promisify(execFile);

/**
 * Matches GitHub PR URLs like:
 *   https://github.com/<owner>/<repo>/pull/<n>
 * Trailing path segments (e.g. /files, /commits) are tolerated.
 */
const PR_URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:\/[^\s]*)?$/i;

export interface GhRunner {
  (args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const defaultGh: GhRunner = async (args) => {
  const { stdout, stderr } = await pexec("gh", args, { maxBuffer: 32 * 1024 * 1024 });
  return { stdout, stderr };
};

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(PR_URL);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export function createGithubLoader(gh: GhRunner = defaultGh): DiffLoader {
  return {
    id: "github",
    matches(locator: string): boolean {
      return parsePrUrl(locator) !== null;
    },
    async load(locator: string): Promise<LoadedDiff> {
      const parsed = parsePrUrl(locator);
      if (!parsed) {
        throw new Error(`not a GitHub PR URL: ${locator}`);
      }
      const repo = `${parsed.owner}/${parsed.repo}`;
      const n = String(parsed.number);

      const viewArgs = [
        "pr",
        "view",
        n,
        "-R",
        repo,
        "--json",
        "title,author,baseRefName,headRefName,state,url",
      ];
      const diffArgs = ["pr", "diff", n, "-R", repo];

      const [view, diff] = await Promise.all([gh(viewArgs), gh(diffArgs)]);

      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(view.stdout);
      } catch {
        meta = { raw: view.stdout };
      }

      return {
        source: "github",
        origin: locator,
        diff: diff.stdout,
        meta,
      };
    },
  };
}

export const githubLoader = createGithubLoader();
