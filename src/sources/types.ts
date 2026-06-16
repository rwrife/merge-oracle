/**
 * A loaded diff, normalized for downstream divination methods.
 */
export interface LoadedDiff {
  /** Where the diff came from (loader id). */
  source: "github" | "file" | "stdin";
  /** Original locator string (URL, path, or "-"). */
  origin: string;
  /** Raw unified diff text. */
  diff: string;
  /** Optional metadata gathered alongside the diff (e.g. PR title). */
  meta?: Record<string, unknown>;
}

export interface DiffLoader {
  readonly id: LoadedDiff["source"];
  /** True if this loader recognizes the given locator. */
  matches(locator: string): boolean;
  /** Load the diff for the given locator. Throws on failure. */
  load(locator: string): Promise<LoadedDiff>;
}
