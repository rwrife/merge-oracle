/**
 * Spread-selection helpers.
 *
 * "Big PR" detection — counts LoC changed in a unified diff (additions +
 * deletions, ignoring +++ / --- file headers) and compares against a
 * configurable threshold. Used to auto-upgrade methods to a richer spread
 * (e.g. tarot's Celtic Cross) when the diff is sizable.
 */

export const DEFAULT_BIG_PR_THRESHOLD = 500;

/** Count the additions + deletions in a unified diff. */
export function countDiffLoc(diff: string): number {
  let total = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.length === 0) continue;
    const c = raw.charCodeAt(0);
    // Skip file headers (+++ / ---) and hunk markers — only real content.
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (c === 43 /* + */ || c === 45 /* - */) total++;
  }
  return total;
}

/** True when the diff's LoC exceeds the big-PR threshold. */
export function isBigDiff(diff: string, threshold = DEFAULT_BIG_PR_THRESHOLD): boolean {
  return countDiffLoc(diff) >= threshold;
}

/**
 * Resolve which spread a method should use.
 *
 * - Explicit `requested` wins when it's in the method's supportedSpreads.
 * - Otherwise, if the method supports `celtic-cross` and the diff is "big",
 *   auto-upgrade.
 * - Otherwise fall back to the method's default spread (or undefined when
 *   the method does not declare spreads at all).
 */
export function resolveSpread(args: {
  supportedSpreads?: ReadonlyArray<{ id: string; default?: boolean }>;
  requested?: string;
  diff: string;
  threshold?: number;
}): { spread: string | undefined; autoUpgraded: boolean } {
  const supported = args.supportedSpreads ?? [];
  const supportedIds = new Set(supported.map((s) => s.id));
  if (args.requested && supportedIds.has(args.requested)) {
    return { spread: args.requested, autoUpgraded: false };
  }
  if (args.requested && !supportedIds.has(args.requested)) {
    // Treat unknown spread as an error upstream; signal by returning
    // undefined + autoUpgraded:false (CLI validates separately).
    return { spread: undefined, autoUpgraded: false };
  }
  const defaultSpread = supported.find((s) => s.default)?.id ?? supported[0]?.id;
  if (supportedIds.has("celtic-cross") && isBigDiff(args.diff, args.threshold)) {
    return { spread: "celtic-cross", autoUpgraded: defaultSpread !== "celtic-cross" };
  }
  return { spread: defaultSpread, autoUpgraded: false };
}
