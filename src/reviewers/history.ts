/**
 * Reviewer mood predictor (issue #36).
 *
 * Given a repo + a list of reviewer logins, we ask the local `gh` CLI for
 * their recent review activity and compute cheap heuristics locally (no LLM
 * calls) — approval/change-request ratios, mean round-trips, top comment
 * n-grams. The aggregated JSON blob is cached in the existing SQLite
 * history database (see `src/history.ts`) with a 24h TTL so we don't hammer
 * the GitHub API.
 *
 * Nothing in this module ever writes to GitHub. It is strictly read-only.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { HistoryStore } from "../history.js";

const pexec = promisify(execFile);

/** Default number of recent closed PRs to scan when computing mood. */
export const DEFAULT_REVIEWER_MOOD_LIMIT = 20;
/** Hard cap enforced by the CLI flag validator. */
export const MAX_REVIEWER_MOOD_LIMIT = 100;
/** How long a cached mood row is considered fresh, in milliseconds. */
export const DEFAULT_REVIEWER_MOOD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Minimal shape of a GitHub review payload we care about. Extra fields on
 * the real API response are ignored; unknown fields on incoming JSON never
 * throw.
 */
export interface ReviewRecord {
  user?: { login?: string } | null;
  state?: string | null;
  submitted_at?: string | null;
  body?: string | null;
}

export interface ReviewerAggregate {
  login: string;
  totalReviews: number;
  approvals: number;
  changesRequested: number;
  commented: number;
  dismissed: number;
  meanRounds: number;
  nitpickRate: number;
  topKeywords: string[];
  tone: ReviewerTone;
  summary: string;
  insufficient?: boolean;
  offline?: boolean;
}

export type ReviewerTone = "pragmatic" | "rigorous" | "encouraging" | "terse" | "unknown";

export interface ReviewerMoodBlob {
  fetchedAt: string;
  ttlMs: number;
  limit: number;
  offline: boolean;
  reviewers: ReviewerAggregate[];
}

export interface GhRunner {
  (args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const defaultGh: GhRunner = async (args) => {
  const { stdout, stderr } = await pexec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return { stdout, stderr };
};

/**
 * Comma-separated string → sanitized list of GitHub logins. Empty entries,
 * leading `@`, and stray whitespace are all normalized. Preserves original
 * order but de-duplicates case-insensitively.
 */
export function parseReviewerList(raw: string | boolean | undefined): string[] {
  if (raw == null || raw === true || raw === false || raw === "") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of String(raw).split(/[,\s]+/)) {
    const login = chunk.replace(/^@/, "").trim();
    if (!login) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(login);
  }
  return out;
}

/**
 * Very small stopword filter used for keyword extraction. We keep this list
 * short so we can ship it inline — the goal is "cheap and directional",
 * not real NLP.
 */
const KEYWORD_STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","else","of","in","on","at","for","to","from",
  "with","without","by","this","that","these","those","is","are","was","were","be","been",
  "being","it","its","i","we","you","they","he","she","them","us","me","my","your","their",
  "our","not","no","nor","so","as","do","does","did","done","have","has","had","having",
  "will","would","should","could","can","may","might","shall","must","also","just","only",
  "please","thanks","thank","lgtm","approved","approve","review","reviewing","reviewers",
  "pr","prs","pull","request","merge","github","comment","comments","file","files","line",
  "lines","code","change","changes","changed","one","two","three","few","many","some","any",
  "all","new","old","get","got","set","let","use","used","using","make","made","see","note",
]);

/**
 * Naive keyword extraction: lowercase, strip punctuation, drop stopwords and
 * very short tokens, count occurrences, return the top N. Deterministic
 * ordering: count desc, then alpha for stable snapshots/tests.
 */
export function extractKeywords(bodies: Array<string | null | undefined>, topN = 3): string[] {
  const counts = new Map<string, number>();
  for (const body of bodies) {
    if (!body) continue;
    const cleaned = body
      .toLowerCase()
      .replace(/```[\s\S]*?```/g, " ") // strip fenced code
      .replace(/`[^`]*`/g, " ") // strip inline code
      .replace(/https?:\/\/\S+/g, " ") // strip URLs
      .replace(/[^a-z0-9\s]/g, " ");
    for (const tok of cleaned.split(/\s+/)) {
      if (tok.length < 3) continue;
      if (KEYWORD_STOPWORDS.has(tok)) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([tok]) => tok);
}

/**
 * "Nit rate" — fraction of review bodies that read like nitpicks. We look
 * for either the literal word "nit" (very common in review threads) or the
 * word "typo" — both are strong signals of a nit-heavy reviewer without
 * needing a real sentiment model.
 */
export function computeNitpickRate(bodies: Array<string | null | undefined>): number {
  const nonEmpty = bodies.filter((b) => typeof b === "string" && b.trim().length > 0) as string[];
  if (nonEmpty.length === 0) return 0;
  const rx = /\b(nit|typo|nitpick)\b/i;
  const hits = nonEmpty.filter((b) => rx.test(b)).length;
  return Number((hits / nonEmpty.length).toFixed(2));
}

/**
 * Turn raw review counts + rate into a short tone label. Kept intentionally
 * coarse — the LLM downstream can add nuance from the aggregated blob.
 */
export function inferTone(agg: {
  approvals: number;
  changesRequested: number;
  commented: number;
  nitpickRate: number;
  meanRounds: number;
}): ReviewerTone {
  const total = agg.approvals + agg.changesRequested + agg.commented;
  if (total === 0) return "unknown";
  if (agg.nitpickRate >= 0.4 || agg.changesRequested / total >= 0.5) return "rigorous";
  if (agg.approvals / total >= 0.7 && agg.meanRounds <= 1.5) return "encouraging";
  if (agg.commented / total >= 0.6) return "terse";
  return "pragmatic";
}

/**
 * Aggregate a single reviewer's raw review list into the compact blob we
 * hand to the LLM. `prCount` is the number of distinct closed PRs we
 * scanned (drives the mean-rounds estimate).
 */
export function aggregateReviewer(
  login: string,
  reviews: ReviewRecord[],
  prCount: number,
): ReviewerAggregate {
  const mine = reviews.filter(
    (r) => (r.user?.login ?? "").toLowerCase() === login.toLowerCase(),
  );
  const approvals = mine.filter((r) => (r.state ?? "").toUpperCase() === "APPROVED").length;
  const changesRequested = mine.filter((r) => (r.state ?? "").toUpperCase() === "CHANGES_REQUESTED").length;
  const commented = mine.filter((r) => (r.state ?? "").toUpperCase() === "COMMENTED").length;
  const dismissed = mine.filter((r) => (r.state ?? "").toUpperCase() === "DISMISSED").length;
  const total = approvals + changesRequested + commented + dismissed;
  // Rounds = total reviews divided by distinct PRs. If we didn't get a PR
  // count from the caller, fall back to 1 to avoid a divide-by-zero.
  const meanRounds = prCount > 0 ? Number((total / prCount).toFixed(2)) : total;
  const nitpickRate = computeNitpickRate(mine.map((r) => r.body));
  const topKeywords = extractKeywords(mine.map((r) => r.body));
  const partial = { approvals, changesRequested, commented, nitpickRate, meanRounds };
  const tone = inferTone(partial);
  const summary = renderReviewerSummary(login, {
    approvals,
    changesRequested,
    commented,
    dismissed,
    meanRounds,
    nitpickRate,
    tone,
    topKeywords,
    total,
  });
  return {
    login,
    totalReviews: total,
    approvals,
    changesRequested,
    commented,
    dismissed,
    meanRounds,
    nitpickRate,
    topKeywords,
    tone,
    summary,
    insufficient: total === 0,
  };
}

interface SummaryInput {
  approvals: number;
  changesRequested: number;
  commented: number;
  dismissed: number;
  meanRounds: number;
  nitpickRate: number;
  tone: ReviewerTone;
  topKeywords: string[];
  total: number;
}

/**
 * One-line human summary. This is what shows up in the terminal card and
 * also seeds the LLM prompt fragment, so keep it compact and factual.
 */
export function renderReviewerSummary(login: string, agg: SummaryInput): string {
  if (agg.total === 0) {
    return `@${login} — insufficient signal (no prior reviews in scan window).`;
  }
  const rateParts = [
    `${agg.approvals} approve`,
    `${agg.changesRequested} changes-requested`,
    `${agg.commented} commented`,
  ];
  if (agg.dismissed > 0) rateParts.push(`${agg.dismissed} dismissed`);
  const kw = agg.topKeywords.length > 0 ? ` Common terms: ${agg.topKeywords.join(", ")}.` : "";
  const nitLabel =
    agg.nitpickRate >= 0.4 ? "high" : agg.nitpickRate >= 0.15 ? "moderate" : "low";
  return (
    `@${login} — ${rateParts.join(" / ")} across scan. ` +
    `Avg ${agg.meanRounds} rounds/PR. Tone: ${agg.tone}. Nitpick rate: ${nitLabel} (${agg.nitpickRate}).` +
    kw
  );
}

/**
 * Auto-detect reviewers from a `gh pr view --json` blob. We union the
 * `requestedReviewers` and `reviews` arrays so both "asked but not yet
 * reviewed" and "actually left a review" logins are covered. CODEOWNERS
 * parsing is intentionally out of scope for v1 (nice-to-have in the AC).
 */
export function extractReviewersFromPrView(meta: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (login: unknown) => {
    if (typeof login !== "string") return;
    const key = login.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(login);
  };
  const m = meta as Record<string, unknown> | null | undefined;
  if (!m || typeof m !== "object") return out;
  const requested = m["requestedReviewers"];
  if (Array.isArray(requested)) {
    for (const r of requested) {
      if (r && typeof r === "object") push((r as Record<string, unknown>)["login"]);
    }
  }
  const reviews = m["reviews"];
  if (Array.isArray(reviews)) {
    for (const r of reviews) {
      if (r && typeof r === "object") {
        const author = (r as Record<string, unknown>)["author"];
        if (author && typeof author === "object") push((author as Record<string, unknown>)["login"]);
        push((r as Record<string, unknown>)["login"]);
      }
    }
  }
  return out;
}

/**
 * Canned "offline" mood so demos and `--offline` runs still render the
 * section without ever hitting the network. We synthesize deterministic
 * numbers from the login string so the same login always shows the same
 * offline mood — surprisingly reassuring for screenshots.
 */
export function offlineMood(login: string): ReviewerAggregate {
  let h = 5381;
  for (let i = 0; i < login.length; i++) h = ((h << 5) + h + login.charCodeAt(i)) | 0;
  const seed = Math.abs(h);
  const approvals = 5 + (seed % 6);
  const changesRequested = 1 + ((seed >> 3) % 4);
  const commented = 2 + ((seed >> 5) % 5);
  const total = approvals + changesRequested + commented;
  const meanRounds = Number((1 + ((seed >> 7) % 3) * 0.5).toFixed(2));
  const nitpickRate = Number((((seed >> 11) % 40) / 100).toFixed(2));
  const tones: ReviewerTone[] = ["pragmatic", "rigorous", "encouraging", "terse"];
  const tone = tones[seed % tones.length];
  const kwPool = ["tests", "types", "nit", "docs", "naming", "logging", "security", "perf"];
  const topKeywords = [0, 1, 2].map((i) => kwPool[(seed + i * 3) % kwPool.length]);
  const summary = renderReviewerSummary(login, {
    approvals,
    changesRequested,
    commented,
    dismissed: 0,
    meanRounds,
    nitpickRate,
    tone,
    topKeywords,
    total,
  });
  return {
    login,
    totalReviews: total,
    approvals,
    changesRequested,
    commented,
    dismissed: 0,
    meanRounds,
    nitpickRate,
    topKeywords,
    tone,
    summary,
    offline: true,
  };
}

/* -------------------------------------------------------------------------- */
/*  SQLite cache                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Cache table lives in the existing history DB so we don't scatter state.
 * We install it lazily so any HistoryStore consumer stays unaffected until
 * they actually ask for reviewer mood.
 */
export function ensureReviewerMoodTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviewer_mood (
      login TEXT NOT NULL,
      repo TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_ms INTEGER NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (login, repo)
    );
  `);
}

export interface CachedMoodRow {
  login: string;
  repo: string;
  updatedMs: number;
  json: string;
}

export function readCachedMood(
  db: Database.Database,
  repo: string,
  login: string,
): CachedMoodRow | null {
  ensureReviewerMoodTable(db);
  const row = db
    .prepare(
      "SELECT login, repo, updated_ms AS updatedMs, json FROM reviewer_mood WHERE login = ? AND repo = ?",
    )
    .get(login.toLowerCase(), repo) as CachedMoodRow | undefined;
  return row ?? null;
}

export function writeCachedMood(
  db: Database.Database,
  repo: string,
  login: string,
  agg: ReviewerAggregate,
  now = Date.now(),
): void {
  ensureReviewerMoodTable(db);
  db.prepare(
    `INSERT INTO reviewer_mood (login, repo, updated_at, updated_ms, json)
     VALUES (?, ?, datetime(?, 'unixepoch'), ?, ?)
     ON CONFLICT(login, repo) DO UPDATE SET
       updated_at = datetime(?, 'unixepoch'),
       updated_ms = ?,
       json       = ?`,
  ).run(
    login.toLowerCase(),
    repo,
    Math.floor(now / 1000),
    now,
    JSON.stringify(agg),
    Math.floor(now / 1000),
    now,
    JSON.stringify(agg),
  );
}

export function isFresh(row: CachedMoodRow, ttlMs: number, now = Date.now()): boolean {
  return now - row.updatedMs < ttlMs;
}

/* -------------------------------------------------------------------------- */
/*  gh fetch layer                                                            */
/* -------------------------------------------------------------------------- */

interface ClosedPrRef {
  number: number;
  user?: string;
}

/**
 * Fetch the last N closed PRs for a repo. Uses `gh api` so we get JSON
 * back directly. `per_page` on the closed-PR endpoint tops out at 100,
 * which matches our `MAX_REVIEWER_MOOD_LIMIT`.
 */
export async function fetchClosedPrs(
  gh: GhRunner,
  repo: string,
  limit: number,
): Promise<ClosedPrRef[]> {
  const per = Math.max(1, Math.min(MAX_REVIEWER_MOOD_LIMIT, limit));
  const { stdout } = await gh([
    "api",
    `repos/${repo}/pulls?state=closed&per_page=${per}`,
    "--jq",
    "[.[] | {number, user: (.user.login // null)}]",
  ]);
  const parsed = JSON.parse(stdout || "[]");
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((r) => r && typeof r === "object" && typeof (r as Record<string, unknown>).number === "number")
    .map((r) => ({
      number: (r as Record<string, unknown>).number as number,
      user: ((r as Record<string, unknown>).user as string | null) ?? undefined,
    }));
}

export async function fetchReviewsForPr(
  gh: GhRunner,
  repo: string,
  prNumber: number,
): Promise<ReviewRecord[]> {
  const { stdout } = await gh([
    "api",
    `repos/${repo}/pulls/${prNumber}/reviews?per_page=100`,
  ]);
  const parsed = JSON.parse(stdout || "[]");
  return Array.isArray(parsed) ? (parsed as ReviewRecord[]) : [];
}

/**
 * Rebuild a fresh mood aggregate for `login` by scanning the last `limit`
 * closed PRs on `repo` and grouping the reviews. Returns an aggregate flag
 * `insufficient: true` when the reviewer has zero reviews in the window.
 */
export async function fetchFreshMood(args: {
  gh: GhRunner;
  repo: string;
  login: string;
  limit: number;
}): Promise<ReviewerAggregate> {
  const closed = await fetchClosedPrs(args.gh, args.repo, args.limit);
  const reviews: ReviewRecord[] = [];
  const seenPrs = new Set<number>();
  for (const pr of closed) {
    let list: ReviewRecord[] = [];
    try {
      list = await fetchReviewsForPr(args.gh, args.repo, pr.number);
    } catch {
      // Individual PR fetch failures should not blow up the whole mood run —
      // a missing review page usually just means the API 404'd on a PR we
      // no longer have visibility into.
      continue;
    }
    if (list.some((r) => (r.user?.login ?? "").toLowerCase() === args.login.toLowerCase())) {
      seenPrs.add(pr.number);
    }
    reviews.push(...list);
  }
  return aggregateReviewer(args.login, reviews, seenPrs.size);
}

/* -------------------------------------------------------------------------- */
/*  Top-level orchestration                                                   */
/* -------------------------------------------------------------------------- */

export interface CollectMoodOptions {
  gh?: GhRunner;
  historyStore?: HistoryStore;
  ttlMs?: number;
  now?: number;
  refresh?: boolean;
  offline?: boolean;
}

/**
 * Public entry point: given a repo and reviewer list, return the compact
 * mood blob. Respects the SQLite cache (24h TTL by default) and the
 * `refresh` / `offline` flags. Never throws for a single reviewer failure
 * — that reviewer gets an insufficient-signal aggregate instead.
 */
export async function collectReviewerMood(args: {
  repo: string | null;
  reviewers: string[];
  limit: number;
} & CollectMoodOptions): Promise<ReviewerMoodBlob> {
  const {
    repo,
    reviewers,
    limit,
    gh = defaultGh,
    ttlMs = DEFAULT_REVIEWER_MOOD_TTL_MS,
    now = Date.now(),
    refresh = false,
    offline = false,
  } = args;

  const uniq = dedupeLogins(reviewers);
  const wantsNetwork = !offline && repo != null;

  const store = args.historyStore ?? (wantsNetwork ? new HistoryStore() : null);
  const shouldClose = args.historyStore == null && store != null;

  try {
    const out: ReviewerAggregate[] = [];
    for (const login of uniq) {
      if (offline || !repo) {
        out.push(offlineMood(login));
        continue;
      }
      const cached = !refresh ? readCachedMood(store!.db, repo, login) : null;
      if (cached && isFresh(cached, ttlMs, now)) {
        try {
          out.push(JSON.parse(cached.json) as ReviewerAggregate);
          continue;
        } catch {
          // Corrupt cache row → fall through to a fresh fetch.
        }
      }
      try {
        const fresh = await fetchFreshMood({ gh, repo, login, limit });
        writeCachedMood(store!.db, repo, login, fresh, now);
        out.push(fresh);
      } catch (err) {
        // A total failure (no gh, no network, API error) degrades to an
        // insufficient-signal row instead of aborting the whole reading.
        out.push({
          ...offlineMood(login),
          summary: `@${login} — insufficient signal (${(err as Error).message || "network unavailable"}).`,
          totalReviews: 0,
          approvals: 0,
          changesRequested: 0,
          commented: 0,
          dismissed: 0,
          insufficient: true,
          offline: false,
        });
      }
    }
    return {
      fetchedAt: new Date(now).toISOString(),
      ttlMs,
      limit,
      offline,
      reviewers: out,
    };
  } finally {
    if (shouldClose && store) store.close();
  }
}

/**
 * Case-insensitive de-dupe that preserves first-seen casing so `@Alice`
 * survives even when a caller also passed `@alice`.
 */
export function dedupeLogins(logins: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const login of logins) {
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(login);
  }
  return out;
}

/**
 * Build the compact JSON blob we splice into the LLM system prompt. Kept
 * separate from the rendered text summary so both channels stay tight.
 */
export function reviewerMoodPromptFragment(blob: ReviewerMoodBlob): string {
  if (blob.reviewers.length === 0) return "";
  const compact = blob.reviewers.map((r) => ({
    login: r.login,
    tone: r.tone,
    approvals: r.approvals,
    changes_requested: r.changesRequested,
    commented: r.commented,
    mean_rounds: r.meanRounds,
    nitpick_rate: r.nitpickRate,
    top_keywords: r.topKeywords,
    insufficient: r.insufficient === true,
    offline: r.offline === true,
  }));
  return [
    "Reviewer mood context (do not quote raw JSON in the reading):",
    JSON.stringify(compact),
    "Weave a one-line-per-reviewer 'reviewer weather' aside beneath the main reading; keep it factual and brief.",
  ].join("\n");
}

/**
 * Render the terminal card section. Silent when there are no reviewers.
 */
export function renderReviewerMoodSection(blob: ReviewerMoodBlob): string {
  if (blob.reviewers.length === 0) return "";
  const lines = ["🌗  Reviewer weather"];
  for (const r of blob.reviewers) {
    lines.push(`    ${r.summary}`);
  }
  if (blob.offline) lines.push("    (offline mood — canned summaries)");
  return lines.join("\n") + "\n";
}

/**
 * JSON-shape helper for `--json` output. Each reviewer becomes one entry
 * under `reading.sections.reviewerMood[]` per the issue AC.
 */
export function reviewerMoodJsonSection(blob: ReviewerMoodBlob): Array<Record<string, unknown>> {
  return blob.reviewers.map((r) => ({
    login: r.login,
    tone: r.tone,
    approvals: r.approvals,
    changesRequested: r.changesRequested,
    commented: r.commented,
    dismissed: r.dismissed,
    meanRounds: r.meanRounds,
    nitpickRate: r.nitpickRate,
    topKeywords: r.topKeywords,
    totalReviews: r.totalReviews,
    insufficient: r.insufficient === true,
    offline: r.offline === true,
    summary: r.summary,
  }));
}
