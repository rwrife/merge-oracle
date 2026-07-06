import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { drawTarot, resetTarotDeckCache, tarotDeckSchema } from "../src/methods/tarot.js";
import { castRunes, resetRunesDeckCache, runesDeckSchema } from "../src/methods/runes.js";
import { loadDeckFromPath, resetDeckRegistry } from "../src/data/decks/_registry.js";
import { DeckValidationError } from "../src/data/decks/types.js";

const TINY_TAROT = {
  $schema: "https://rwrife.github.io/merge-oracle/deck.schema.json",
  id: "tiny-tarot-int",
  name: "Tiny (three-card only)",
  method: "tarot",
  version: 1,
  cards: [
    { id: "one",   name: "Card One",   keywords: ["a"], upright: "u1", reversed: "r1" },
    { id: "two",   name: "Card Two",   keywords: ["b"], upright: "u2", reversed: "r2" },
    { id: "three", name: "Card Three", keywords: ["c"], upright: "u3", reversed: "r3" },
    { id: "four",  name: "Card Four",  keywords: ["d"], upright: "u4", reversed: "r4" },
  ],
};

const SIX_RUNES = {
  id: "six-runes-int",
  name: "Six Runes",
  method: "runes",
  version: 1,
  cards: [
    { id: "one",   glyph: "①", name: "One",   keywords: ["a"], upright: "u1", reversed: "r1" },
    { id: "two",   glyph: "②", name: "Two",   keywords: ["b"], upright: "u2", reversed: "r2" },
    { id: "three", glyph: "③", name: "Three", keywords: ["c"], upright: "u3", reversed: "r3" },
    { id: "four",  glyph: "④", name: "Four",  keywords: ["d"], upright: "u4", reversed: "r4" },
    { id: "five",  glyph: "⑤", name: "Five",  keywords: ["e"], upright: "u5", reversed: "r5" },
    { id: "six",   glyph: "⑥", name: "Six",   keywords: ["f"], upright: "u6", reversed: "r6" },
  ],
};

describe("tarot deck integration", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), "oracle-decks-tarot-"));
    resetTarotDeckCache();
    resetDeckRegistry();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    resetTarotDeckCache();
    resetDeckRegistry();
  });

  it("draws from a custom deck when passed via opts", () => {
    const path = resolve(tmp, "tiny.json");
    writeFileSync(path, JSON.stringify(TINY_TAROT));
    const deck = loadDeckFromPath(path);
    const cards = drawTarot("hello world", { deck });
    expect(cards).toHaveLength(3);
    for (const c of cards) {
      expect(c.id).toMatch(/^arcana:(one|two|three|four)$/);
    }
  });

  it("default deck still works without opts (bundled major-arcana)", () => {
    const cards = drawTarot("hello world");
    expect(cards).toHaveLength(3);
    // Default deck is the 22-card Major Arcana; numeric ids appear as arcana:N.
    for (const c of cards) {
      expect(c.id).toMatch(/^arcana:\d+$/);
    }
  });

  it("rejects a deck whose method is not tarot", () => {
    const bad = { ...TINY_TAROT, method: "runes" as const, id: "wrong-method" };
    const path = resolve(tmp, "wrong.json");
    writeFileSync(path, JSON.stringify(bad));
    const deck = loadDeckFromPath(path);
    expect(() => drawTarot("diff", { deck })).toThrow(/not 'tarot'/);
  });

  it("rejects a card missing a required field with the offending index", () => {
    const bad = {
      ...TINY_TAROT,
      id: "missing-field",
      cards: [
        TINY_TAROT.cards[0],
        // Second card omits `reversed`.
        { id: "two", name: "Two", keywords: ["b"], upright: "u2" },
        TINY_TAROT.cards[2],
      ],
    };
    const path = resolve(tmp, "bad.json");
    writeFileSync(path, JSON.stringify(bad));
    const deck = loadDeckFromPath(path);
    const err = catchError(() => drawTarot("diff", { deck }));
    expect(err).toBeInstanceOf(DeckValidationError);
    expect(err!.message).toMatch(/card #1/);
    expect(err!.message).toMatch(/reversed/);
  });

  it("celtic-cross spread demands ≥10 cards with a readable error", () => {
    const path = resolve(tmp, "tiny.json");
    writeFileSync(path, JSON.stringify(TINY_TAROT));
    const deck = loadDeckFromPath(path);
    expect(() => drawTarot("diff", { deck, spread: "celtic-cross" })).toThrow(
      /needs 10/,
    );
  });

  it("unknown card fields are silently ignored", () => {
    const withExtras = {
      ...TINY_TAROT,
      id: "with-extras",
      cards: TINY_TAROT.cards.map((c) => ({ ...c, artCredit: "Someone", note: 42 })),
    };
    const path = resolve(tmp, "extras.json");
    writeFileSync(path, JSON.stringify(withExtras));
    const deck = loadDeckFromPath(path);
    const cards = drawTarot("diff", { deck });
    expect(cards).toHaveLength(3);
  });

  it("tarotDeckSchema exposes its method id", () => {
    expect(tarotDeckSchema.method).toBe("tarot");
  });
});

describe("runes deck integration", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), "oracle-decks-runes-"));
    resetRunesDeckCache();
    resetDeckRegistry();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    resetRunesDeckCache();
    resetDeckRegistry();
  });

  it("casts from a custom deck when passed via opts", () => {
    const path = resolve(tmp, "six.json");
    writeFileSync(path, JSON.stringify(SIX_RUNES));
    const deck = loadDeckFromPath(path);
    const stones = castRunes("hello world", { deck });
    expect(stones).toHaveLength(3);
    for (const s of stones) expect(s.id).toMatch(/^rune:(one|two|three|four|five|six)$/);
  });

  it("default deck still casts Elder Futhark without opts", () => {
    const stones = castRunes("hello world");
    expect(stones).toHaveLength(3);
    for (const s of stones) expect(s.id).toMatch(/^rune:(fehu|uruz|thurisaz|ansuz|raidho|kenaz|gebo|wunjo|hagalaz|nauthiz|isa|jera|eihwaz|perthro|algiz|sowilo|tiwaz|berkano|ehwaz|mannaz|laguz|ingwaz|dagaz|othala)$/);
  });

  it("rejects a deck whose method is not runes", () => {
    const bad = { ...SIX_RUNES, method: "tarot" as const, id: "wrong-method-runes" };
    const path = resolve(tmp, "wrong.json");
    writeFileSync(path, JSON.stringify(bad));
    const deck = loadDeckFromPath(path);
    expect(() => castRunes("diff", { deck })).toThrow(/not 'runes'/);
  });

  it("rejects a card missing `glyph`", () => {
    const bad = {
      ...SIX_RUNES,
      id: "no-glyph",
      cards: [
        SIX_RUNES.cards[0],
        SIX_RUNES.cards[1],
        // Third card omits glyph.
        { id: "x", name: "X", keywords: ["c"], upright: "u", reversed: "r" },
        SIX_RUNES.cards[3],
      ],
    };
    const path = resolve(tmp, "bad.json");
    writeFileSync(path, JSON.stringify(bad));
    const deck = loadDeckFromPath(path);
    const err = catchError(() => castRunes("diff", { deck }));
    expect(err).toBeInstanceOf(DeckValidationError);
    expect(err!.message).toMatch(/card #2/);
    expect(err!.message).toMatch(/glyph/);
  });

  it("rejects a deck with fewer than 3 runes", () => {
    const skinny = { ...SIX_RUNES, id: "skinny", cards: SIX_RUNES.cards.slice(0, 2) };
    const path = resolve(tmp, "skinny.json");
    writeFileSync(path, JSON.stringify(skinny));
    const deck = loadDeckFromPath(path);
    expect(() => castRunes("diff", { deck })).toThrow(/at least 3/);
  });

  it("runesDeckSchema exposes its method id", () => {
    expect(runesDeckSchema.method).toBe("runes");
  });
});

describe("bundled example decks are valid", () => {
  it("examples/decks/tiny-tarot.json loads and draws", () => {
    resetTarotDeckCache();
    const deck = loadDeckFromPath(resolve(__dirname, "../examples/decks/tiny-tarot.json"));
    expect(deck.method).toBe("tarot");
    const cards = drawTarot("example diff", { deck });
    expect(cards).toHaveLength(3);
  });

  it("examples/decks/office-runes.json loads and casts", () => {
    resetRunesDeckCache();
    const deck = loadDeckFromPath(resolve(__dirname, "../examples/decks/office-runes.json"));
    expect(deck.method).toBe("runes");
    const stones = castRunes("example diff", { deck });
    expect(stones).toHaveLength(3);
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
