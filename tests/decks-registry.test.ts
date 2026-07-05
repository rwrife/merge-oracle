import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DECKS_DIR_ENV,
  describeDeckSource,
  getDeckById,
  listDecks,
  loadDeckFromPath,
  parseDeckJson,
  resetDeckRegistry,
  resolveDeck,
} from "../src/data/decks/_registry.js";
import { DeckValidationError } from "../src/data/decks/types.js";

// Freshen the registry between tests when we mess with the env var.
function withEnvDir(dir: string | null, fn: () => void): void {
  const prev = process.env[DECKS_DIR_ENV];
  if (dir === null) delete process.env[DECKS_DIR_ENV];
  else process.env[DECKS_DIR_ENV] = dir;
  resetDeckRegistry();
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[DECKS_DIR_ENV];
    else process.env[DECKS_DIR_ENV] = prev;
    resetDeckRegistry();
  }
}

const MINIMAL_TAROT = {
  $schema: "https://rwrife.github.io/merge-oracle/deck.schema.json",
  id: "unit-tarot",
  name: "Unit-Test Tarot",
  method: "tarot",
  version: 1,
  cards: [
    { id: "a", name: "A", keywords: ["one"], upright: "u", reversed: "r" },
    { id: "b", name: "B", keywords: ["two"], upright: "u", reversed: "r" },
    { id: "c", name: "C", keywords: ["three"], upright: "u", reversed: "r" },
  ],
};

describe("decks/registry envelope validation", () => {
  it("parseDeckJson accepts a well-formed deck", () => {
    const doc = parseDeckJson(JSON.stringify(MINIMAL_TAROT), null);
    expect(doc.id).toBe("unit-tarot");
    expect(doc.method).toBe("tarot");
    expect(doc.cards).toHaveLength(3);
  });

  it("rejects invalid JSON with a readable message", () => {
    expect(() => parseDeckJson("{not json", null)).toThrow(DeckValidationError);
  });

  it("rejects non-object payloads", () => {
    expect(() => parseDeckJson("[]", null)).toThrow(/must be a JSON object/);
    expect(() => parseDeckJson('"nope"', null)).toThrow(/must be a JSON object/);
  });

  it("lists every missing envelope field in a single error", () => {
    const err = catchError(() => parseDeckJson("{}", null));
    expect(err).toBeInstanceOf(DeckValidationError);
    expect(err!.message).toMatch(/id/);
    expect(err!.message).toMatch(/name/);
    expect(err!.message).toMatch(/method/);
    expect(err!.message).toMatch(/version/);
    expect(err!.message).toMatch(/cards/);
  });

  it("rejects ids with unfriendly characters", () => {
    const bad = { ...MINIMAL_TAROT, id: "no spaces please" };
    expect(() => parseDeckJson(JSON.stringify(bad), null)).toThrow(/deck id must be/);
  });

  it("rejects empty card arrays", () => {
    const bad = { ...MINIMAL_TAROT, cards: [] };
    expect(() => parseDeckJson(JSON.stringify(bad), null)).toThrow(/has no cards/);
  });
});

describe("decks/registry bundled discovery", () => {
  it("finds every bundled deck", () => {
    withEnvDir(null, () => {
      const decks = listDecks();
      const ids = decks.map((d) => d.id);
      // Every deck we ship is exercised by an existing method test — asserting
      // presence here catches an accidental rename of the bundled files.
      expect(ids).toEqual(
        expect.arrayContaining([
          "major-arcana",
          "elder-futhark",
          "i-ching",
          "tea-leaves",
          "zodiac",
        ]),
      );
      for (const d of decks) {
        expect(d.source).toBe("bundled");
        expect(d.sourcePath).toBeTruthy();
      }
    });
  });

  it("filters by method id", () => {
    withEnvDir(null, () => {
      const tarot = listDecks("tarot");
      expect(tarot.map((d) => d.id)).toEqual(["major-arcana"]);
      const runes = listDecks("runes");
      expect(runes.map((d) => d.id)).toEqual(["elder-futhark"]);
    });
  });

  it("getDeckById returns undefined for unknown ids", () => {
    withEnvDir(null, () => {
      expect(getDeckById("nope")).toBeUndefined();
      expect(getDeckById("major-arcana")?.method).toBe("tarot");
    });
  });
});

describe("decks/registry env-dir discovery", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), "oracle-decks-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("merges $MERGE_ORACLE_DECKS_DIR decks into the registry", () => {
    writeFileSync(resolve(tmp, "unit.json"), JSON.stringify(MINIMAL_TAROT));
    withEnvDir(tmp, () => {
      const deck = getDeckById("unit-tarot");
      expect(deck).toBeDefined();
      expect(deck!.source).toBe("env");
      expect(deck!.sourcePath).toContain(tmp);
      expect(describeDeckSource(deck!)).toMatch(/^env:/);
    });
  });

  it("refuses to override a bundled deck id", () => {
    // Attempt to shadow the bundled major-arcana deck.
    const shadow = { ...MINIMAL_TAROT, id: "major-arcana" };
    writeFileSync(resolve(tmp, "shadow.json"), JSON.stringify(shadow));
    withEnvDir(tmp, () => {
      const restore = silenceStderr();
      try {
        const deck = getDeckById("major-arcana");
        // Bundled wins; the env shadow is dropped with a warning (asserted below).
        expect(deck?.source).toBe("bundled");
        expect(restore.captured()).toMatch(/collides with bundled deck/);
      } finally {
        restore.done();
      }
    });
  });

  it("ignores non-json files in the env dir", () => {
    writeFileSync(resolve(tmp, "notes.txt"), "not a deck");
    writeFileSync(resolve(tmp, "unit.json"), JSON.stringify(MINIMAL_TAROT));
    withEnvDir(tmp, () => {
      expect(getDeckById("unit-tarot")).toBeDefined();
    });
  });

  it("silently ignores a non-existent env dir", () => {
    withEnvDir(resolve(tmp, "does-not-exist"), () => {
      // Bundled decks still discoverable; no throw.
      expect(getDeckById("major-arcana")).toBeDefined();
    });
  });
});

describe("decks/registry resolveDeck", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), "oracle-decks-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads a deck from a direct file path (source='arg')", () => {
    const path = resolve(tmp, "hand.json");
    writeFileSync(path, JSON.stringify(MINIMAL_TAROT));
    const deck = loadDeckFromPath(path);
    expect(deck.source).toBe("arg");
    expect(deck.sourcePath).toBe(path);
    expect(deck.id).toBe("unit-tarot");
  });

  it("resolveDeck prefers a file path when the arg resolves to a file", () => {
    const path = resolve(tmp, "hand.json");
    writeFileSync(path, JSON.stringify(MINIMAL_TAROT));
    const deck = resolveDeck(path, "tarot");
    expect(deck.source).toBe("arg");
  });

  it("resolveDeck falls back to registry id lookup", () => {
    withEnvDir(null, () => {
      const deck = resolveDeck("major-arcana", "tarot");
      expect(deck.source).toBe("bundled");
      expect(deck.id).toBe("major-arcana");
    });
  });

  it("resolveDeck rejects a method mismatch with a helpful message", () => {
    withEnvDir(null, () => {
      const err = catchError(() => resolveDeck("major-arcana", "runes"));
      expect(err).toBeInstanceOf(DeckValidationError);
      expect(err!.message).toMatch(/for method 'tarot', not 'runes'/);
    });
  });

  it("resolveDeck throws on unknown id + non-file", () => {
    expect(() => resolveDeck("definitely-does-not-exist-xyz", "tarot")).toThrow(
      /no deck found/,
    );
  });

  it("loadDeckFromPath throws when the file is missing", () => {
    expect(() => loadDeckFromPath(resolve(tmp, "missing.json"))).toThrow(
      /deck file not found/,
    );
  });
});

describe("decks/registry describeDeckSource", () => {
  it("labels bundled decks plainly", () => {
    withEnvDir(null, () => {
      const bundled = getDeckById("major-arcana")!;
      expect(describeDeckSource(bundled)).toBe("bundled");
    });
  });
});

function catchError(fn: () => unknown): Error | null {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  return null;
}

function silenceStderr(): { captured: () => string; done: () => void } {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    captured: () => chunks.join(""),
    done: () => {
      process.stderr.write = orig;
    },
  };
}
