import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateReviewer,
  collectReviewerMood,
  computeNitpickRate,
  dedupeLogins,
  DEFAULT_REVIEWER_MOOD_TTL_MS,
  extractKeywords,
  extractReviewersFromPrView,
  inferTone,
  isFresh,
  offlineMood,
  parseReviewerList,
  readCachedMood,
  renderReviewerMoodSection,
  reviewerMoodJsonSection,
  reviewerMoodPromptFragment,
  writeCachedMood,
  type GhRunner,
  type ReviewRecord,
} from "../src/reviewers/history.js";
import { HistoryStore } from "../src/history.js";

/** Shorthand for building a review record inline in fixtures. */
function rev(login: string, state: string, body: string | null = null, submitted_at?: string): ReviewRecord {
  return { user: { login }, state, body, submitted_at: submitted_at ?? "2026-06-01T00:00:00Z" };
}

describe("reviewers/history — parsing helpers", () => {
  it("parses comma / space separated logins, tolerates '@' prefix", () => {
    expect(parseReviewerList("alice,bob,@carol")).toEqual(["alice", "bob", "carol"]);
    expect(parseReviewerList("alice bob   carol")).toEqual(["alice", "bob", "carol"]);
    expect(parseReviewerList("alice, alice, ALICE")).toEqual(["alice"]);
    expect(parseReviewerList("")).toEqual([]);
    expect(parseReviewerList(undefined)).toEqual([]);
    // Boolean "true" (from commander's optional-value flag) means "auto-detect": no explicit list.
    expect(parseReviewerList(true)).toEqual([]);
  });

  it("de-dupes logins case-insensitively, preserving first casing", () => {
    expect(dedupeLogins(["Alice", "bob", "alice", "BOB"])).toEqual(["Alice", "bob"]);
  });

  it("auto-detects reviewers from a gh pr view JSON blob", () => {
    const meta = {
      requestedReviewers: [{ login: "alice" }, { login: "bob" }],
      reviews: [
        { author: { login: "bob" }, state: "APPROVED" },
        { author: { login: "carol" }, state: "COMMENTED" },
        { login: "dave", state: "COMMENTED" }, // some payloads flatten login
      ],
    };
    expect(extractReviewersFromPrView(meta)).toEqual(["alice", "bob", "carol", "dave"]);
  });

  it("returns [] when meta is missing or malformed", () => {
    expect(extractReviewersFromPrView(undefined)).toEqual([]);
    expect(extractReviewersFromPrView(null)).toEqual([]);
    expect(extractReviewersFromPrView({ requestedReviewers: "nope" })).toEqual([]);
  });
});

describe("reviewers/history — heuristics", () => {
  it("extracts top keywords, filters stopwords + code fences", () => {
    const bodies = [
      "nit: please add more tests for the auth flow",
      "tests are still missing here; add tests",
      "```code\nthis should be ignored\n```\nnaming looks fine",
    ];
    const kw = extractKeywords(bodies, 3);
    expect(kw).toContain("tests");
    // Deterministic ordering: same input → same output.
    expect(kw).toEqual(extractKeywords(bodies, 3));
  });

  it("computes nitpick rate from body content", () => {
    expect(computeNitpickRate(["nit: rename x", "lgtm", "typo here"])).toBe(0.67);
    expect(computeNitpickRate(["lgtm", "ship it"])).toBe(0);
    expect(computeNitpickRate([])).toBe(0);
    // Whitespace-only bodies are ignored in the denominator.
    expect(computeNitpickRate(["  ", "nit: y"])).toBe(1);
  });

  it("infers tone from ratios", () => {
    expect(inferTone({ approvals: 8, changesRequested: 1, commented: 1, nitpickRate: 0.05, meanRounds: 1 })).toBe("encouraging");
    expect(inferTone({ approvals: 2, changesRequested: 6, commented: 2, nitpickRate: 0.1, meanRounds: 3 })).toBe("rigorous");
    expect(inferTone({ approvals: 3, changesRequested: 1, commented: 8, nitpickRate: 0.05, meanRounds: 2 })).toBe("terse");
    expect(inferTone({ approvals: 3, changesRequested: 2, commented: 3, nitpickRate: 0.1, meanRounds: 2 })).toBe("pragmatic");
    expect(inferTone({ approvals: 0, changesRequested: 0, commented: 0, nitpickRate: 0, meanRounds: 0 })).toBe("unknown");
  });

  it("aggregates a reviewer's reviews from fixture payloads", () => {
    const reviews: ReviewRecord[] = [
      rev("alice", "APPROVED"),
      rev("alice", "CHANGES_REQUESTED", "nit: add tests for the parser"),
      rev("alice", "COMMENTED", "types could be tighter here"),
      rev("bob", "APPROVED"),
      rev("Alice", "APPROVED", "lgtm"), // case-insensitive match on the login
    ];
    const agg = aggregateReviewer("alice", reviews, 3);
    expect(agg.login).toBe("alice");
    expect(agg.approvals).toBe(2);
    expect(agg.changesRequested).toBe(1);
    expect(agg.commented).toBe(1);
    expect(agg.totalReviews).toBe(4);
    // 4 reviews across 3 distinct PRs → ~1.33 rounds.
    expect(agg.meanRounds).toBeCloseTo(1.33, 2);
    expect(agg.tone).not.toBe("unknown");
    expect(agg.topKeywords.length).toBeGreaterThan(0);
    expect(agg.summary).toMatch(/^@alice/);
  });

  it("marks a login with no matching reviews as insufficient", () => {
    const agg = aggregateReviewer("ghost", [rev("alice", "APPROVED")], 1);
    expect(agg.insufficient).toBe(true);
    expect(agg.totalReviews).toBe(0);
    expect(agg.summary).toMatch(/insufficient signal/);
  });
});

describe("reviewers/history — offline mood", () => {
  it("returns deterministic canned data flagged offline", () => {
    const a = offlineMood("alice");
    const b = offlineMood("alice");
    expect(a).toEqual(b);
    expect(a.offline).toBe(true);
    expect(a.totalReviews).toBeGreaterThan(0);
    expect(a.summary).toContain("@alice");
  });

  it("gives different logins different (but stable) moods", () => {
    const a = offlineMood("alice");
    const b = offlineMood("bob");
    // At least one dimension should differ across logins.
    expect(
      a.tone !== b.tone ||
        a.approvals !== b.approvals ||
        a.nitpickRate !== b.nitpickRate,
    ).toBe(true);
  });
});

describe("reviewers/history — SQLite cache + TTL", () => {
  let dir: string;
  let store: HistoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oracle-mood-"));
    store = new HistoryStore(join(dir, "history.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a mood row and respects the TTL boundary", () => {
    const agg = offlineMood("alice");
    const anchor = 1_000_000_000_000;
    writeCachedMood(store.db, "rwrife/merge-oracle", "alice", agg, anchor);

    const row = readCachedMood(store.db, "rwrife/merge-oracle", "alice");
    expect(row).not.toBeNull();
    expect(row!.updatedMs).toBe(anchor);
    expect(JSON.parse(row!.json).login).toBe("alice");

    // Within TTL.
    expect(isFresh(row!, DEFAULT_REVIEWER_MOOD_TTL_MS, anchor + DEFAULT_REVIEWER_MOOD_TTL_MS - 1)).toBe(true);
    // At / beyond TTL.
    expect(isFresh(row!, DEFAULT_REVIEWER_MOOD_TTL_MS, anchor + DEFAULT_REVIEWER_MOOD_TTL_MS)).toBe(false);
  });

  it("upserts (same login + repo => single row)", () => {
    writeCachedMood(store.db, "rwrife/merge-oracle", "alice", offlineMood("alice"), 100);
    writeCachedMood(store.db, "rwrife/merge-oracle", "alice", offlineMood("alice"), 200);
    const row = readCachedMood(store.db, "rwrife/merge-oracle", "alice");
    expect(row!.updatedMs).toBe(200);
  });
});

describe("reviewers/history — collect orchestration", () => {
  let dir: string;
  let store: HistoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oracle-mood-collect-"));
    store = new HistoryStore(join(dir, "history.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("offline mode returns canned moods, never touches gh", async () => {
    let called = false;
    const gh: GhRunner = async () => {
      called = true;
      return { stdout: "[]", stderr: "" };
    };
    const blob = await collectReviewerMood({
      repo: "rwrife/merge-oracle",
      reviewers: ["alice", "bob"],
      limit: 20,
      gh,
      offline: true,
      historyStore: store,
    });
    expect(called).toBe(false);
    expect(blob.offline).toBe(true);
    expect(blob.reviewers.map((r) => r.login)).toEqual(["alice", "bob"]);
    expect(blob.reviewers.every((r) => r.offline === true)).toBe(true);
  });

  it("hits gh, aggregates, and caches; a second call skips gh", async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      // First `gh api repos/.../pulls?...` → return two PR refs.
      if (args[1].startsWith("repos/") && args[1].includes("/pulls?")) {
        return { stdout: JSON.stringify([{ number: 1 }, { number: 2 }]), stderr: "" };
      }
      // Per-PR reviews endpoint.
      const prMatch = args[1].match(/pulls\/(\d+)\/reviews/);
      if (prMatch) {
        const n = Number(prMatch[1]);
        const payload =
          n === 1
            ? [rev("alice", "APPROVED", "lgtm"), rev("bob", "COMMENTED", "nit: rename")]
            : [rev("alice", "CHANGES_REQUESTED", "please add tests for the parser")];
        return { stdout: JSON.stringify(payload), stderr: "" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const anchor = 1_700_000_000_000;
    const first = await collectReviewerMood({
      repo: "rwrife/merge-oracle",
      reviewers: ["alice"],
      limit: 5,
      gh,
      historyStore: store,
      now: anchor,
    });
    expect(first.reviewers).toHaveLength(1);
    const aliceFirst = first.reviewers[0];
    expect(aliceFirst.approvals).toBe(1);
    expect(aliceFirst.changesRequested).toBe(1);
    expect(aliceFirst.totalReviews).toBe(2);
    const callsAfterFirst = calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second call within TTL — must hit cache, not gh.
    const second = await collectReviewerMood({
      repo: "rwrife/merge-oracle",
      reviewers: ["alice"],
      limit: 5,
      gh,
      historyStore: store,
      now: anchor + 60_000,
    });
    expect(calls.length).toBe(callsAfterFirst); // no new gh calls
    expect(second.reviewers[0].approvals).toBe(aliceFirst.approvals);

    // refresh=true forces gh again.
    await collectReviewerMood({
      repo: "rwrife/merge-oracle",
      reviewers: ["alice"],
      limit: 5,
      gh,
      historyStore: store,
      now: anchor + 60_000,
      refresh: true,
    });
    expect(calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("gh failure degrades to an insufficient-signal row (never throws)", async () => {
    const gh: GhRunner = async () => {
      throw new Error("gh not installed");
    };
    const blob = await collectReviewerMood({
      repo: "rwrife/merge-oracle",
      reviewers: ["alice"],
      limit: 5,
      gh,
      historyStore: store,
    });
    expect(blob.reviewers).toHaveLength(1);
    expect(blob.reviewers[0].insufficient).toBe(true);
    expect(blob.reviewers[0].summary).toMatch(/insufficient signal/);
  });

  it("no repo → falls back to offline moods without hitting gh", async () => {
    let called = false;
    const gh: GhRunner = async () => {
      called = true;
      return { stdout: "[]", stderr: "" };
    };
    const blob = await collectReviewerMood({
      repo: null,
      reviewers: ["alice"],
      limit: 5,
      gh,
      historyStore: store,
    });
    expect(called).toBe(false);
    expect(blob.reviewers[0].offline).toBe(true);
  });
});

describe("reviewers/history — render + prompt helpers", () => {
  it("renders a terminal section with a per-reviewer line", () => {
    const blob = {
      fetchedAt: "2026-07-06T00:00:00Z",
      ttlMs: DEFAULT_REVIEWER_MOOD_TTL_MS,
      limit: 20,
      offline: true,
      reviewers: [offlineMood("alice"), offlineMood("bob")],
    };
    const text = renderReviewerMoodSection(blob);
    expect(text).toContain("Reviewer weather");
    expect(text).toContain("@alice");
    expect(text).toContain("@bob");
    expect(text).toContain("(offline mood");
  });

  it("returns an empty string when there are no reviewers", () => {
    expect(
      renderReviewerMoodSection({
        fetchedAt: "x",
        ttlMs: 0,
        limit: 0,
        offline: false,
        reviewers: [],
      }),
    ).toBe("");
  });

  it("builds a compact JSON section fit for --json output", () => {
    const blob = {
      fetchedAt: "2026-07-06T00:00:00Z",
      ttlMs: DEFAULT_REVIEWER_MOOD_TTL_MS,
      limit: 20,
      offline: true,
      reviewers: [offlineMood("alice")],
    };
    const section = reviewerMoodJsonSection(blob);
    expect(section).toHaveLength(1);
    expect(section[0].login).toBe("alice");
    expect(section[0].summary).toBeTypeOf("string");
    expect(section[0].topKeywords).toBeInstanceOf(Array);
  });

  it("builds a compact prompt fragment for the LLM", () => {
    const blob = {
      fetchedAt: "2026-07-06T00:00:00Z",
      ttlMs: DEFAULT_REVIEWER_MOOD_TTL_MS,
      limit: 20,
      offline: true,
      reviewers: [offlineMood("alice")],
    };
    const fragment = reviewerMoodPromptFragment(blob);
    expect(fragment).toContain("Reviewer mood context");
    // Should embed compact JSON, not the human summary.
    expect(fragment).toContain("\"login\":\"alice\"");
    expect(fragment).not.toContain("Nitpick rate:"); // that's the render-side wording
  });

  it("empty reviewer list → empty prompt fragment (zero token cost)", () => {
    expect(
      reviewerMoodPromptFragment({
        fetchedAt: "x",
        ttlMs: 0,
        limit: 0,
        offline: false,
        reviewers: [],
      }),
    ).toBe("");
  });
});
