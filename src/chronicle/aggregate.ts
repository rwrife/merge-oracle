/**
 * Chronicle aggregator (issue #40).
 *
 * Given a set of past readings, compute the compact metrics the chronicle
 * command displays and hands to the LLM. Everything here is a pure
 * function over `HistoryRow` inputs so it's cheap to snapshot-test.
 *
 * Design goals:
 *  - deterministic ordering (count desc, then alpha) for stable snapshots.
 *  - never explode on bad JSON in `symbols_json` — the DB is user-writable
 *    and old rows may have shapes we don't recognize yet.
 *  - stay method-agnostic: any past reading contributes symbols, whether
 *    from tarot, runes, i-ching, tea-leaves, astrology, or numerology.
 */

import type { HistoryRow } from "../history.js";
import type { ReviewerAggregate, ReviewerMoodBlob } from "../reviewers/history.js";

export interface ChronicleOmen {
  /** Canonical symbol id, e.g. "the-fool", "fehu", "hexagram-11". */
  id: string;
  /** Display name if we can find one in the row's symbol payload. */
  name: string | null;
  /** Number of readings that drew this symbol. */
  count: number;
  /** Fraction of readings featuring this symbol (0..1). */
  frequency: number;
  /** Which methods drew it (deduped). */
  methods: string[];
}

export interface ChronicleWeather {
  reviewers: ReviewerAggregate[];
  /** Fleeting aggregate for the narrative: overall approval leaning. */
  moodLabel: "warming" | "cooling" | "mixed" | "unknown";
  /** Total reviews summed across everyone. */
  totalReviews: number;
  approvals: number;
  changesRequested: number;
  commented: number;
}

export interface ChronicleAggregate {
  /** How many readings we consumed. */
  readings: number;
  /** { methodId → count }, sorted desc. */
  methodTallies: Array<{ methodId: string; count: number }>;
  dominantMethod: string | null;
  /** { personaId → count }, sorted desc. */
  personaTallies: Array<{ personaId: string; count: number }>;
  dominantPersona: string | null;
  /** { outcome → count }, e.g. merged / closed / abandoned / pending. */
  outcomeTallies: Record<string, number>;
  omens: ChronicleOmen[];
  weather: ChronicleWeather | null;
  /** Unique repos represented (owner/name), sorted alpha. */
  repos: string[];
}

/**
 * A row's `symbols_json` is untyped — different methods embed different
 * shapes. This walker pulls out anything that looks like a symbol id and
 * (optionally) a display name so the aggregator can count occurrences.
 */
export function extractSymbols(symbolsJson: string): Array<{ id: string; name: string | null }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(symbolsJson);
  } catch {
    return [];
  }
  const out: Array<{ id: string; name: string | null }> = [];
  const seenPerRow = new Set<string>();
  const visit = (node: unknown) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === "object") {
      const rec = node as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : null;
      if (id) {
        const key = id.toLowerCase();
        if (!seenPerRow.has(key)) {
          seenPerRow.add(key);
          const name = typeof rec.name === "string" ? rec.name : null;
          out.push({ id, name });
        }
      }
      // Some methods nest inside `card`, `rune`, `hexagram`, etc. Recurse
      // over object values so we catch those too.
      for (const value of Object.values(rec)) {
        if (value && (typeof value === "object" || Array.isArray(value))) visit(value);
      }
    }
  };
  visit(parsed);
  return out;
}

/**
 * Tally rows by a column and return a sorted array. Ties broken alpha.
 */
function tally<T extends string>(rows: HistoryRow[], key: (r: HistoryRow) => T | null | undefined): Array<{ id: T; count: number }> {
  const counts = new Map<T, number>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))
    .map(([id, count]) => ({ id, count }));
}

/**
 * Weather roll-up across a reviewer-mood blob. When the caller couldn't
 * assemble a blob (no `--with-reviewer-mood` in prior readings, or
 * `--offline` without a repo) we return `null` and the chronicle just
 * omits the weather section.
 */
export function summarizeWeather(mood: ReviewerMoodBlob | null): ChronicleWeather | null {
  if (!mood || mood.reviewers.length === 0) return null;
  let approvals = 0;
  let changesRequested = 0;
  let commented = 0;
  for (const r of mood.reviewers) {
    approvals += r.approvals;
    changesRequested += r.changesRequested;
    commented += r.commented;
  }
  const total = approvals + changesRequested + commented;
  let moodLabel: ChronicleWeather["moodLabel"] = "unknown";
  if (total > 0) {
    const approvalRate = approvals / total;
    const pushbackRate = changesRequested / total;
    if (approvalRate >= 0.6 && pushbackRate <= 0.2) moodLabel = "warming";
    else if (pushbackRate >= 0.4) moodLabel = "cooling";
    else moodLabel = "mixed";
  }
  return {
    reviewers: mood.reviewers,
    moodLabel,
    totalReviews: total,
    approvals,
    changesRequested,
    commented,
  };
}

/**
 * The workhorse: reduce a set of readings into the chronicle aggregate.
 * `topOmens` bounds the number of recurring omens returned (default 3 per
 * the acceptance criteria).
 */
export function aggregateReadings(rows: HistoryRow[], opts: {
  topOmens?: number;
  weather?: ReviewerMoodBlob | null;
} = {}): ChronicleAggregate {
  const topOmens = Math.max(1, opts.topOmens ?? 3);
  const methodTallies = tally(rows, (r) => r.methodId).map((t) => ({ methodId: t.id, count: t.count }));
  const personaTallies = tally(rows, (r) => r.personaId).map((t) => ({ personaId: t.id, count: t.count }));

  const outcomeTallies: Record<string, number> = {};
  for (const r of rows) {
    const k = r.outcome ?? "pending";
    outcomeTallies[k] = (outcomeTallies[k] ?? 0) + 1;
  }

  // Omen counts: iterate rows once, remember method-per-symbol so we can
  // list which decks/systems keep coughing up the same sign.
  const omenCounts = new Map<string, { count: number; name: string | null; methods: Set<string> }>();
  for (const r of rows) {
    for (const sym of extractSymbols(r.symbolsJson)) {
      const key = sym.id.toLowerCase();
      const cur = omenCounts.get(key) ?? { count: 0, name: sym.name, methods: new Set<string>() };
      cur.count += 1;
      if (!cur.name && sym.name) cur.name = sym.name;
      cur.methods.add(r.methodId);
      omenCounts.set(key, cur);
    }
  }

  const omens: ChronicleOmen[] = [...omenCounts.entries()]
    .map(([id, data]) => ({
      id,
      name: data.name,
      count: data.count,
      frequency: rows.length > 0 ? Number((data.count / rows.length).toFixed(2)) : 0,
      methods: [...data.methods].sort(),
    }))
    // We only want *recurring* omens for the highlight reel: a symbol
    // that showed up in exactly one reading isn't a pattern.
    .filter((o) => o.count > 1 || rows.length === 1)
    .sort((a, b) => (b.count - a.count) || a.id.localeCompare(b.id))
    .slice(0, topOmens);

  const repos = [...new Set(rows.map((r) => r.repo).filter((r): r is string => !!r))].sort();

  return {
    readings: rows.length,
    methodTallies,
    dominantMethod: methodTallies[0]?.methodId ?? null,
    personaTallies,
    dominantPersona: personaTallies[0]?.personaId ?? null,
    outcomeTallies,
    omens,
    weather: summarizeWeather(opts.weather ?? null),
    repos,
  };
}
