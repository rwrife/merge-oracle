import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore, historyEnabledFromEnv, parsePrOrigin, renderHistoryTable } from "../src/history.js";
import type { LoadedDiff } from "../src/sources/types.js";

function makeLoaded(overrides: Partial<LoadedDiff> = {}): LoadedDiff {
  return {
    source: "file",
    origin: "/tmp/example.diff",
    diff: "diff --git a/x b/x\n+hello\n",
    ...overrides,
  };
}

describe("history", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oracle-history-"));
    dbPath = join(dir, "history.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses GitHub PR origins and ignores others", () => {
    expect(parsePrOrigin("https://github.com/rwrife/merge-oracle/pull/42")).toEqual({
      repo: "rwrife/merge-oracle", prNumber: 42, prUrl: "https://github.com/rwrife/merge-oracle/pull/42",
    });
    expect(parsePrOrigin("/tmp/foo.diff")).toEqual({ repo: null, prNumber: null, prUrl: null });
  });

  it("honors ORACLE_HISTORY env flag", () => {
    const prev = process.env.ORACLE_HISTORY;
    try {
      delete process.env.ORACLE_HISTORY;
      expect(historyEnabledFromEnv()).toBe(true);
      process.env.ORACLE_HISTORY = "0";
      expect(historyEnabledFromEnv()).toBe(false);
      process.env.ORACLE_HISTORY = "off";
      expect(historyEnabledFromEnv()).toBe(false);
      process.env.ORACLE_HISTORY = "1";
      expect(historyEnabledFromEnv()).toBe(true);
    } finally {
      if (prev == null) delete process.env.ORACLE_HISTORY;
      else process.env.ORACLE_HISTORY = prev;
    }
  });

  it("inserts, lists, updates outcomes, and computes stats", () => {
    const store = new HistoryStore(dbPath);
    const a = store.insert({
      loaded: makeLoaded({ source: "github", origin: "https://github.com/rwrife/merge-oracle/pull/7", diff: "a\n" }),
      methodId: "tarot",
      personaId: "crone",
      spread: "three-card",
      symbols: [{ id: "fool" }],
      reading: "the fool leaps",
      channel: "offline",
    });
    const b = store.insert({
      loaded: makeLoaded({ diff: "b\n" }),
      methodId: "runes",
      personaId: "crone",
      symbols: [{ id: "fehu" }],
      reading: "cattle equals wealth",
    });
    expect(a.id).toBe(1);
    expect(a.repo).toBe("rwrife/merge-oracle");
    expect(a.prNumber).toBe(7);
    expect(a.diffSha256).toHaveLength(64);
    expect(b.repo).toBeNull();

    const all = store.list();
    expect(all.map((r) => r.id)).toEqual([2, 1]);

    const filtered = store.list({ methodId: "tarot" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe(1);

    const byRepo = store.list({ repo: "rwrife/merge-oracle" });
    expect(byRepo).toHaveLength(1);

    const updated = store.setOutcome(a.id, "merged");
    expect(updated?.outcome).toBe("merged");
    expect(updated?.outcomeAt).toBeTruthy();

    // Missing id → null.
    expect(store.setOutcome(9999, "closed")).toBeNull();

    const stats = store.stats();
    expect(stats.total).toBe(2);
    expect(stats.byOutcome.merged).toBe(1);
    expect(stats.byOutcome.pending).toBe(1);
    const tarotStats = stats.byMethod.find((m) => m.methodId === "tarot")!;
    expect(tarotStats.merged).toBe(1);
    const runesStats = stats.byMethod.find((m) => m.methodId === "runes")!;
    expect(runesStats.pending).toBe(1);

    store.close();

    // Persistence: reopen and confirm rows survive.
    const store2 = new HistoryStore(dbPath);
    expect(store2.list()).toHaveLength(2);
    expect(store2.get(1)?.outcome).toBe("merged");
    store2.close();
  });

  it("renders an empty history message when nothing is stored", () => {
    const store = new HistoryStore(dbPath);
    const rendered = renderHistoryTable(store.list());
    expect(rendered).toContain("no readings recorded yet");
    store.close();
  });
});
