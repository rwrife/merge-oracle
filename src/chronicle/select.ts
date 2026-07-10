/**
 * Chronicle selectors (issue #40).
 *
 * The chronicle command asks a single question: "which readings from the
 * local history DB should we consult?" This module answers it. Selectors
 * are pure over the DB rows they receive, so most of the interesting logic
 * is trivially unit-testable against a fixture DB.
 *
 * The one impure escape hatch is `--milestone=<name>`, which needs `gh api`
 * to resolve the milestone's merged PR numbers before filtering rows. That
 * lookup is injected via a `GhRunner` so tests can stub it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HistoryStore, type HistoryRow } from "../history.js";

const pexec = promisify(execFile);

export interface GhRunner {
  (args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const defaultGh: GhRunner = async (args) => {
  const { stdout, stderr } = await pexec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return { stdout, stderr };
};

/** Raw selection knobs from the CLI. All fields optional; combinations validated below. */
export interface ChronicleSelection {
  last?: number;
  since?: string; // ISO date or datetime
  until?: string;
  milestone?: string;
  all?: boolean;
  repo?: string; // filter to a single repo (owner/name)
}

/** What the chronicle actually consulted, echoed back into JSON + narrative. */
export interface ChronicleSelectionSummary {
  strategy: "last" | "range" | "milestone" | "all";
  last: number | null;
  since: string | null;
  until: string | null;
  milestone: string | null;
  repo: string | null;
  count: number;
  dateRange: { earliest: string | null; latest: string | null };
}

export class ChronicleSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChronicleSelectionError";
  }
}

/**
 * Validate the selector combination. Returns the resolved strategy or
 * throws a `ChronicleSelectionError` when the caller passed something
 * incoherent (e.g. `--last` and `--milestone` together, or nothing at all).
 */
export function resolveStrategy(sel: ChronicleSelection): "last" | "range" | "milestone" | "all" {
  const strategies: Array<"last" | "range" | "milestone" | "all"> = [];
  if (typeof sel.last === "number") strategies.push("last");
  if (sel.since != null || sel.until != null) strategies.push("range");
  if (sel.milestone != null && sel.milestone !== "") strategies.push("milestone");
  if (sel.all) strategies.push("all");
  if (strategies.length === 0) {
    throw new ChronicleSelectionError(
      "chronicle: pick one of --last=<n>, --since/--until, --milestone=<name>, or --all",
    );
  }
  if (strategies.length > 1) {
    throw new ChronicleSelectionError(
      `chronicle: selectors are mutually exclusive (got ${strategies.join(", ")})`,
    );
  }
  return strategies[0];
}

/** Parse an ISO date/datetime bound. Returns null for undefined/empty. */
export function parseBound(raw: string | undefined | null): string | null {
  if (raw == null || raw === "") return null;
  // Allow both `YYYY-MM-DD` and full ISO timestamps.
  const trimmed = raw.trim();
  const asDate = new Date(trimmed);
  if (Number.isNaN(asDate.getTime())) {
    throw new ChronicleSelectionError(`chronicle: invalid date '${raw}'`);
  }
  // Normalize to ISO for stable SQL comparison against `created_at`
  // (SQLite CURRENT_TIMESTAMP format is `YYYY-MM-DD HH:MM:SS`; ISO
  // strings compare correctly lexicographically for that shape after we
  // strip the trailing `T`/`Z`).
  return asDate.toISOString().replace("T", " ").replace(/\.\d+Z$/, "").replace(/Z$/, "");
}

/**
 * Fetch merged PR numbers for a given milestone via `gh api`. Returns an
 * empty array when the milestone is unknown or has no merged PRs — never
 * throws for that case; callers translate to a friendly message.
 */
export async function fetchMilestonePrNumbers(args: {
  gh?: GhRunner;
  repo: string;
  milestone: string;
}): Promise<number[]> {
  const gh = args.gh ?? defaultGh;
  // The search API is the cheapest way to enumerate PRs in a milestone
  // without pagination gymnastics for the common case (< 100).
  const q = `repo:${args.repo} is:pr is:merged milestone:"${args.milestone}"`;
  let stdout = "";
  try {
    ({ stdout } = await gh(["api", "-X", "GET", "search/issues", "-f", `q=${q}`, "--jq", ".items[].number"]));
  } catch (err) {
    throw new ChronicleSelectionError(
      `chronicle: gh milestone lookup failed for '${args.milestone}' (${(err as Error).message || "unknown error"})`,
    );
  }
  const nums: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isFinite(n) && n > 0) nums.push(n);
  }
  return nums;
}

/**
 * Pure filter over a set of DB rows. Applied after any raw SQL narrowing
 * (repo, method, persona) so we can keep the SQL small.
 */
export function filterRows(rows: HistoryRow[], filter: {
  strategy: "last" | "range" | "milestone" | "all";
  last?: number;
  sinceIso?: string | null;
  untilIso?: string | null;
  prNumbers?: number[];
}): HistoryRow[] {
  let out = rows.slice();
  if (filter.strategy === "range") {
    const since = filter.sinceIso;
    const until = filter.untilIso;
    out = out.filter((r) => {
      if (since && r.createdAt < since) return false;
      if (until && r.createdAt > until) return false;
      return true;
    });
  } else if (filter.strategy === "milestone") {
    const wanted = new Set(filter.prNumbers ?? []);
    out = out.filter((r) => r.prNumber != null && wanted.has(r.prNumber));
  } else if (filter.strategy === "last") {
    // Rows arrive newest-first from HistoryStore.list; a straight slice is
    // the "last N" the user asked for.
    out = out.slice(0, Math.max(1, filter.last ?? 10));
  }
  // strategy === "all" → no additional filtering.
  return out;
}

/**
 * End-to-end selector: resolve strategy, pull rows from the store, apply
 * the strategy-specific filter, and return both the rows and a summary
 * blob for the chronicle output.
 */
export async function selectReadings(args: {
  selection: ChronicleSelection;
  store: HistoryStore;
  gh?: GhRunner;
}): Promise<{ rows: HistoryRow[]; summary: ChronicleSelectionSummary }> {
  const strategy = resolveStrategy(args.selection);
  const sinceIso = parseBound(args.selection.since);
  const untilIso = parseBound(args.selection.until);
  const repo = args.selection.repo ?? undefined;

  let prNumbers: number[] | undefined;
  if (strategy === "milestone") {
    if (!repo) {
      throw new ChronicleSelectionError(
        "chronicle: --milestone requires --repo=<owner/name> so the oracle knows where to look",
      );
    }
    prNumbers = await fetchMilestonePrNumbers({ gh: args.gh, repo, milestone: args.selection.milestone! });
  }

  // Pull an oversize page from SQLite and let filterRows shape it.
  // For "last=N" we tighten the limit to keep the query small.
  const limit = strategy === "last" ? Math.max(1, args.selection.last ?? 10) : 1000;
  const rows = args.store.list({ repo, limit });
  const filtered = filterRows(rows, { strategy, last: args.selection.last, sinceIso, untilIso, prNumbers });

  const dates = filtered.map((r) => r.createdAt).sort();
  const summary: ChronicleSelectionSummary = {
    strategy,
    last: strategy === "last" ? (args.selection.last ?? 10) : null,
    since: sinceIso,
    until: untilIso,
    milestone: strategy === "milestone" ? (args.selection.milestone ?? null) : null,
    repo: repo ?? null,
    count: filtered.length,
    dateRange: {
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
    },
  };
  return { rows: filtered, summary };
}
