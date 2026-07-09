import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "../src/history.js";
import type { LoadedDiff } from "../src/sources/types.js";
import {
  aggregateReadings,
  extractSymbols,
  summarizeWeather,
} from "../src/chronicle/aggregate.js";
import {
  ChronicleSelectionError,
  filterRows,
  parseBound,
  resolveStrategy,
  selectReadings,
} from "../src/chronicle/select.js";
import {
  extractProphecy,
  renderChronicleCard,
  renderOfflineChronicle,
  runChronicle,
} from "../src/chronicle/run.js";
import { createOfflineClient } from "../src/llm/client.js";
import { getPersona } from "../src/personas/_registry.js";

function makeLoaded(overrides: Partial<LoadedDiff> = {}): LoadedDiff {
  return {
    source: "github",
    origin: "https://github.com/rwrife/merge-oracle/pull/1",
    diff: "diff --git a/x b/x\n+hello\n",
    ...overrides,
  };
}

describe("chronicle/select — strategy validation", () => {
  it("throws when no selector given", () => {
    expect(() => resolveStrategy({})).toThrow(ChronicleSelectionError);
  });

  it("throws when multiple selectors mixed", () => {
    expect(() => resolveStrategy({ last: 5, all: true })).toThrow(ChronicleSelectionError);
    expect(() => resolveStrategy({ milestone: "v1", since: "2026-01-01" })).toThrow(ChronicleSelectionError);
  });

  it("accepts each selector on its own", () => {
    expect(resolveStrategy({ last: 5 })).toBe("last");
    expect(resolveStrategy({ since: "2026-01-01" })).toBe("range");
    expect(resolveStrategy({ until: "2026-01-01" })).toBe("range");
    expect(resolveStrategy({ milestone: "v0.2" })).toBe("milestone");
    expect(resolveStrategy({ all: true })).toBe("all");
  });

  it("parses dates and rejects garbage", () => {
    expect(parseBound(undefined)).toBeNull();
    expect(parseBound("")).toBeNull();
    expect(parseBound("2026-07-01")?.startsWith("2026-07-01")).toBe(true);
    expect(() => parseBound("not-a-date")).toThrow(ChronicleSelectionError);
  });
});

describe("chronicle/aggregate — extractSymbols", () => {
  it("returns empty on invalid JSON", () => {
    expect(extractSymbols("{not json")).toEqual([]);
  });

  it("pulls flat symbol ids with optional names", () => {
    expect(extractSymbols(JSON.stringify([{ id: "fool", name: "The Fool" }, { id: "sun" }])))
      .toEqual([{ id: "fool", name: "The Fool" }, { id: "sun", name: null }]);
  });

  it("recurses into nested payloads (card, hexagram, etc.)", () => {
    const payload = JSON.stringify([
      { card: { id: "the-hermit", name: "The Hermit" } },
      { hexagram: { id: "hex-11", name: "Peace" } },
      { rune: { id: "fehu" } },
    ]);
    const syms = extractSymbols(payload);
    expect(syms.map((s) => s.id).sort()).toEqual(["fehu", "hex-11", "the-hermit"]);
  });

  it("de-dupes within a single row (case-insensitive)", () => {
    const payload = JSON.stringify([{ id: "Fool" }, { id: "fool" }, { id: "FOOL" }]);
    expect(extractSymbols(payload)).toHaveLength(1);
  });
});

describe("chronicle/aggregate — aggregateReadings", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oracle-chronicle-"));
    dbPath = join(dir, "history.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("computes method/persona tallies and dominant method", () => {
    const store = new HistoryStore(dbPath);
    for (let i = 0; i < 3; i++) {
      store.insert({
        loaded: makeLoaded({ origin: `https://github.com/rwrife/merge-oracle/pull/${i + 1}` }),
        methodId: "tarot",
        personaId: "crone",
        symbols: [{ id: "fool", name: "The Fool" }],
        reading: `r${i}`,
      });
    }
    store.insert({
      loaded: makeLoaded({ origin: "https://github.com/rwrife/merge-oracle/pull/9" }),
      methodId: "runes",
      personaId: "default",
      symbols: [{ id: "fehu", name: "Fehu" }, { id: "fool", name: "The Fool" }],
      reading: "runes-1",
    });
    const rows = store.list({ limit: 100 });
    const agg = aggregateReadings(rows);
    expect(agg.readings).toBe(4);
    expect(agg.dominantMethod).toBe("tarot");
    expect(agg.methodTallies.find((m) => m.methodId === "tarot")?.count).toBe(3);
    expect(agg.methodTallies.find((m) => m.methodId === "runes")?.count).toBe(1);
    expect(agg.dominantPersona).toBe("crone");
    // "fool" appears in 4 rows → top omen; "fehu" appears once (singleton) → filtered.
    expect(agg.omens.map((o) => o.id)).toEqual(["fool"]);
    expect(agg.omens[0].count).toBe(4);
    expect(agg.omens[0].methods.sort()).toEqual(["runes", "tarot"]);
    expect(agg.repos).toEqual(["rwrife/merge-oracle"]);
    store.close();
  });

  it("tracks outcome tallies including pending", () => {
    const store = new HistoryStore(dbPath);
    const a = store.insert({
      loaded: makeLoaded(),
      methodId: "tarot",
      personaId: "crone",
      symbols: [{ id: "fool" }],
      reading: "a",
    });
    store.insert({
      loaded: makeLoaded({ origin: "https://github.com/rwrife/merge-oracle/pull/2" }),
      methodId: "tarot",
      personaId: "crone",
      symbols: [{ id: "fool" }],
      reading: "b",
    });
    store.setOutcome(a.id, "merged");
    const agg = aggregateReadings(store.list({ limit: 100 }));
    expect(agg.outcomeTallies.merged).toBe(1);
    expect(agg.outcomeTallies.pending).toBe(1);
    store.close();
  });

  it("filters singleton omens except when there is only one reading", () => {
    const store = new HistoryStore(dbPath);
    store.insert({
      loaded: makeLoaded(),
      methodId: "tarot",
      personaId: "crone",
      symbols: [{ id: "only-one" }, { id: "another-one" }],
      reading: "solo",
    });
    // With exactly one reading, "recurring" isn't meaningful — surface both.
    const agg = aggregateReadings(store.list({ limit: 100 }));
    expect(agg.omens.map((o) => o.id).sort()).toEqual(["another-one", "only-one"]);
    store.close();
  });
});

describe("chronicle/aggregate — summarizeWeather", () => {
  it("returns null when there's no mood blob", () => {
    expect(summarizeWeather(null)).toBeNull();
    expect(summarizeWeather({ fetchedAt: "", ttlMs: 0, limit: 0, offline: false, reviewers: [] })).toBeNull();
  });

  it("labels warming when approvals dominate", () => {
    const w = summarizeWeather({
      fetchedAt: "", ttlMs: 0, limit: 20, offline: false,
      reviewers: [{
        login: "alice", tone: "encouraging", totalReviews: 10,
        approvals: 8, changesRequested: 1, commented: 1, dismissed: 0,
        meanRounds: 1, nitpickRate: 0.1, topKeywords: [], summary: "",
      }],
    });
    expect(w?.moodLabel).toBe("warming");
  });

  it("labels cooling when changes-requested dominate", () => {
    const w = summarizeWeather({
      fetchedAt: "", ttlMs: 0, limit: 20, offline: false,
      reviewers: [{
        login: "bob", tone: "rigorous", totalReviews: 10,
        approvals: 2, changesRequested: 6, commented: 2, dismissed: 0,
        meanRounds: 2, nitpickRate: 0.4, topKeywords: [], summary: "",
      }],
    });
    expect(w?.moodLabel).toBe("cooling");
  });
});

describe("chronicle/select — filterRows + selectReadings", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oracle-chronicle-sel-"));
    dbPath = join(dir, "history.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("last=N slices the newest rows", async () => {
    const store = new HistoryStore(dbPath);
    for (let i = 0; i < 5; i++) {
      store.insert({
        loaded: makeLoaded({ origin: `https://github.com/rwrife/merge-oracle/pull/${i + 1}` }),
        methodId: "tarot",
        personaId: "crone",
        symbols: [{ id: "s" }],
        reading: `r${i}`,
      });
    }
    const { rows, summary } = await selectReadings({
      selection: { last: 3 },
      store,
    });
    expect(rows).toHaveLength(3);
    expect(summary.strategy).toBe("last");
    expect(summary.count).toBe(3);
    store.close();
  });

  it("milestone selector filters to matching PR numbers via injected gh", async () => {
    const store = new HistoryStore(dbPath);
    for (const n of [1, 2, 3, 4]) {
      store.insert({
        loaded: makeLoaded({ origin: `https://github.com/rwrife/merge-oracle/pull/${n}` }),
        methodId: "tarot",
        personaId: "crone",
        symbols: [{ id: "s" }],
        reading: `r${n}`,
      });
    }
    const stubGh = async () => ({ stdout: "2\n4\n", stderr: "" });
    const { rows, summary } = await selectReadings({
      selection: { milestone: "v0.2", repo: "rwrife/merge-oracle" },
      store,
      gh: stubGh,
    });
    expect(rows.map((r) => r.prNumber).sort()).toEqual([2, 4]);
    expect(summary.milestone).toBe("v0.2");
    store.close();
  });

  it("milestone selector requires --repo", async () => {
    const store = new HistoryStore(dbPath);
    await expect(selectReadings({ selection: { milestone: "v0.2" }, store }))
      .rejects.toBeInstanceOf(ChronicleSelectionError);
    store.close();
  });

  it("filterRows applies since/until bounds correctly", () => {
    const now = "2026-07-01 12:00:00";
    const rows = [
      { createdAt: "2026-06-15 10:00:00" } as any,
      { createdAt: "2026-07-01 12:00:00" } as any,
      { createdAt: "2026-07-05 09:00:00" } as any,
    ];
    const out = filterRows(rows, { strategy: "range", sinceIso: now, untilIso: null });
    expect(out).toHaveLength(2);
  });
});

describe("chronicle/run — offline narrative + runChronicle", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oracle-chronicle-run-"));
    dbPath = join(dir, "history.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedStore(): HistoryStore {
    const store = new HistoryStore(dbPath);
    for (let i = 0; i < 3; i++) {
      store.insert({
        loaded: makeLoaded({ origin: `https://github.com/rwrife/merge-oracle/pull/${i + 1}` }),
        methodId: "tarot",
        personaId: "crone",
        spread: "three-card",
        symbols: [{ id: "the-fool", name: "The Fool" }, { id: "the-tower", name: "The Tower" }],
        reading: `r${i}`,
      });
    }
    store.insert({
      loaded: makeLoaded({ origin: "https://github.com/rwrife/merge-oracle/pull/9" }),
      methodId: "runes",
      personaId: "default",
      symbols: [{ id: "the-tower", name: "The Tower" }],
      reading: "runes-1",
    });
    return store;
  }

  it("renderOfflineChronicle consumes real aggregates and produces the expected shape", async () => {
    const store = seedStore();
    const { rows, summary } = await selectReadings({ selection: { last: 10 }, store });
    const aggregate = aggregateReadings(rows);
    const persona = getPersona("crone")!;
    const narrative = renderOfflineChronicle({ aggregate, selection: summary, persona });
    expect(narrative).toMatchSnapshot();
    // The narrative must mention the actual dominant method and the top omen.
    expect(narrative).toContain("tarot");
    expect(narrative).toContain("The Tower");
    // Should honor all five section glyphs from the AC.
    for (const glyph of ["⚱️", "🕯️", "🌗", "📜", "🔮"]) {
      expect(narrative).toContain(glyph);
    }
    store.close();
  });

  it("runChronicle in offline mode returns narrative + offline channel", async () => {
    const store = seedStore();
    const { rows, summary } = await selectReadings({ selection: { last: 10 }, store });
    const aggregate = aggregateReadings(rows);
    const persona = getPersona("crone")!;
    const client = createOfflineClient(persona.offlineLines([]));
    const reading = await runChronicle({ aggregate, selection: summary, persona, client, offline: true });
    expect(reading.channel).toBe("offline:mock");
    expect(reading.narrative).toContain("⚱️ The gathering");
    store.close();
  });

  it("runChronicle in online mode calls the client with a chronicle prompt", async () => {
    const store = seedStore();
    const { rows, summary } = await selectReadings({ selection: { last: 10 }, store });
    const aggregate = aggregateReadings(rows);
    const persona = getPersona("crone")!;
    let capturedMessages: any = null;
    const fakeClient = {
      id: "fake:model",
      async complete(messages: any) {
        capturedMessages = messages;
        return "⚱️ ok\n🕯️ ok\n🌗 ok\n📜 ok\n🔮 The prophecy: onward.";
      },
    };
    const reading = await runChronicle({ aggregate, selection: summary, persona, client: fakeClient, offline: false });
    expect(reading.channel).toBe("fake:model");
    // The chronicle prompt must not include a diff block.
    const text = capturedMessages.map((m: any) => m.content).join("\n");
    expect(text).not.toContain("```diff");
    // It must mention the strategy and the omens.
    expect(text).toContain("strategy=last");
    expect(text).toContain("Recurring omens");
    // Persona system message appended.
    expect(text).toContain("Persona — the Crone");
    store.close();
  });

  it("renderChronicleCard includes strategy + persona header", async () => {
    const store = seedStore();
    const { rows, summary } = await selectReadings({ selection: { last: 10 }, store });
    const aggregate = aggregateReadings(rows);
    const persona = getPersona("crone")!;
    const client = createOfflineClient([]);
    const reading = await runChronicle({ aggregate, selection: summary, persona, client, offline: true });
    const card = renderChronicleCard({ aggregate, selection: summary, persona, reading });
    expect(card).toContain("🔮 chronicle");
    expect(card).toContain("strategy: last");
    expect(card).toContain("persona: the Crone");
    store.close();
  });

  it("extractProphecy pulls the last 🔮 line", () => {
    expect(extractProphecy("⚱️ hi\n🔮 The prophecy: winter comes")).toBe("winter comes");
    expect(extractProphecy("⚱️ nothing here")).toBeNull();
  });
});
