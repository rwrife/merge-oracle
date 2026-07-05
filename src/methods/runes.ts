import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ChatMessage } from "../llm/prompts.js";
import { assembleReadingPrompt } from "../llm/prompts.js";
import type { DivinationMethod, DrawnSymbol, MethodCallOptions } from "./types.js";
import type { DeckSchema, LoadedDeck } from "../data/decks/types.js";
import { DeckValidationError } from "../data/decks/types.js";

interface Rune {
  id: string;
  glyph: string;
  name: string;
  keywords: string[];
  upright: string;
  reversed: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = resolve(HERE, "../data/decks/elder-futhark.json");
const DEFAULT_DECK_CARDS: Rune[] = (
  JSON.parse(readFileSync(DECK_PATH, "utf8")) as { cards: Rune[] }
).cards;

/** Id of the bundled default runes deck. */
export const DEFAULT_RUNES_DECK_ID = "elder-futhark";

const SPREAD: ReadonlyArray<{ slot: string; gloss: string }> = [
  { slot: "Situation", gloss: "what the diff truly is, beneath its commit message" },
  { slot: "Obstacle",  gloss: "the hidden friction this change must overcome" },
  { slot: "Outcome",   gloss: "the rune cast for what merging brings" },
];

/**
 * Per-method card schema. Consumed by the deck registry / validators; unknown
 * fields are ignored, missing required fields throw a message the registry
 * annotates with the deck id and card index.
 */
export const runesDeckSchema: DeckSchema<Rune> = {
  method: "runes",
  validateCard(raw: unknown, index: number): Rune {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new DeckValidationError(`card #${index}: expected an object`, { cardIndex: index });
    }
    const r = raw as Record<string, unknown>;
    const missing: string[] = [];
    const id = typeof r.id === "string" ? r.id : null;
    const glyph = typeof r.glyph === "string" ? r.glyph : null;
    const name = typeof r.name === "string" ? r.name : null;
    const upright = typeof r.upright === "string" ? r.upright : null;
    const reversed = typeof r.reversed === "string" ? r.reversed : null;
    const keywords = Array.isArray(r.keywords) && r.keywords.every((k) => typeof k === "string")
      ? (r.keywords as string[])
      : null;
    if (!id) missing.push("id");
    if (!glyph) missing.push("glyph");
    if (!name) missing.push("name");
    if (!upright) missing.push("upright");
    if (!reversed) missing.push("reversed");
    if (!keywords) missing.push("keywords[]");
    if (missing.length > 0) {
      throw new DeckValidationError(
        `card #${index} is missing required field(s): ${missing.join(", ")}`,
        { cardIndex: index },
      );
    }
    return {
      id: id!,
      glyph: glyph!,
      name: name!,
      upright: upright!,
      reversed: reversed!,
      keywords: keywords!,
    };
  },
};

const VALIDATED: Map<string, Rune[]> = new Map();

function resolveDeckCards(opts?: MethodCallOptions): Rune[] {
  if (!opts?.deck) return DEFAULT_DECK_CARDS;
  return validateDeckOnce(opts.deck);
}

function validateDeckOnce(deck: LoadedDeck): Rune[] {
  const cached = VALIDATED.get(deck.id);
  if (cached) return cached;
  if (deck.method !== "runes") {
    throw new DeckValidationError(
      `deck '${deck.id}' is for method '${deck.method}', not 'runes'`,
      { deckId: deck.id },
    );
  }
  const cards: Rune[] = deck.cards.map((c, i) => {
    try {
      return runesDeckSchema.validateCard(c, i);
    } catch (err) {
      const msg = err instanceof DeckValidationError ? err.message : String(err);
      throw new DeckValidationError(`deck '${deck.id}': ${msg}`, {
        deckId: deck.id,
        cardIndex: i,
      });
    }
  });
  if (cards.length < 3) {
    throw new DeckValidationError(
      `deck '${deck.id}' has only ${cards.length} runes; a cast needs at least 3`,
      { deckId: deck.id },
    );
  }
  VALIDATED.set(deck.id, cards);
  return cards;
}

function hashRunes(diff: string): number {
  // Use a different byte slice from tarot so the two methods don't lockstep.
  return createHash("sha256").update(diff).digest().readUInt32BE(4);
}

/**
 * Deterministically cast three distinct runes from the resolved deck.
 * Same diff → same cast → same orientations.
 */
export function castRunes(diff: string, opts?: MethodCallOptions): DrawnSymbol[] {
  const runeSet = resolveDeckCards(opts);
  const seed = hashRunes(diff);
  let state = seed === 0 ? 0x9e3779b1 : seed;
  const next = () => {
    // xorshift32 — different generator from tarot's LCG so signatures diverge.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };

  const indices: number[] = [];
  while (indices.length < 3) {
    const candidate = next() % runeSet.length;
    if (!indices.includes(candidate)) indices.push(candidate);
  }

  return indices.map((idx, i) => {
    const rune = runeSet[idx];
    const reversed = (next() & 1) === 1;
    return {
      id: `rune:${rune.id}`,
      name: `${rune.glyph} ${rune.name}`,
      position: SPREAD[i].slot,
      reversed,
      meta: {
        glyph: rune.glyph,
        runeName: rune.name,
        keywords: rune.keywords,
        upright: rune.upright,
        reversed: rune.reversed,
        slotGloss: SPREAD[i].gloss,
      },
    } satisfies DrawnSymbol;
  });
}

function describeSymbol(s: DrawnSymbol): string {
  const meta = s.meta as {
    runeName: string;
    keywords: string[];
    upright: string;
    reversed: string;
    slotGloss: string;
  };
  const meaning = s.reversed ? meta.reversed : meta.upright;
  const orientation = s.reversed ? "merkstave (reversed)" : "upright";
  const kw = meta.keywords.join(", ");
  return `${s.position} — ${meta.runeName} (${orientation}) [${kw}] :: ${meaning}`;
}

const STONE_W = 9;
const STONE_H = 5;

/**
 * Render three rune stones side by side. Reversed runes are marked with
 * an "↯" and their glyph is wrapped in brackets so even glyph-less terminals
 * communicate orientation.
 */
export function renderRunesAscii(symbols: DrawnSymbol[]): string {
  const stones = symbols.map((s) => buildStone(s));
  const rows: string[] = [];
  for (let r = 0; r < STONE_H; r++) {
    rows.push(stones.map((s) => s[r]).join("   "));
  }
  const labels = symbols
    .map((s) => {
      const orient = s.reversed ? "↯" : "✶";
      const meta = s.meta as { runeName: string };
      return centerPad(`${s.position}: ${meta.runeName} ${orient}`, 18);
    })
    .join(" ");
  return [rows.join("\n"), "", labels].join("\n");
}

function buildStone(s: DrawnSymbol): string[] {
  const meta = s.meta as { glyph: string };
  const top = "+" + "-".repeat(STONE_W - 2) + "+";
  const empty = "|" + " ".repeat(STONE_W - 2) + "|";
  const glyphLine = "|" + centerPad(s.reversed ? `[${meta.glyph}]` : ` ${meta.glyph} `, STONE_W - 2) + "|";
  const lines = [top, empty, glyphLine, empty, top];
  while (lines.length < STONE_H) lines.push(empty);
  return lines;
}

function centerPad(text: string, width: number): string {
  // Naive width — runes are typically rendered as 1-2 cells. Treat as 1 cell
  // so snapshots stay stable across terminals.
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

/** Reset validation cache — test helper. */
export function resetRunesDeckCache(): void {
  VALIDATED.clear();
}

export const runes: DivinationMethod = {
  id: "runes",
  name: "Runes — Situation / Obstacle / Outcome",
  describe() {
    return "casts three Elder Futhark runes seeded by the diff hash and reads them as Situation, Obstacle, and Outcome of the merge.";
  },
  draw(diff: string, opts?: MethodCallOptions) {
    return castRunes(diff, opts);
  },
  readingPrompt(symbols: DrawnSymbol[], diff: string, opts?: MethodCallOptions): ChatMessage[] {
    const symbolStrings = symbols.map(describeSymbol);
    const deckLabel = opts?.deck ? ` (deck: ${opts.deck.name})` : "";
    const extraSystem = [
      `You are reading a 3-rune Elder Futhark cast${deckLabel} for a pull request.`,
      "Address each rune in order (Situation, Obstacle, Outcome) in 1–2 sentences,",
      "tying each rune's meaning to something concrete in the diff.",
      "Reversed runes are called 'merkstave' — read their warning meaning.",
      "Close with a single 'Verdict:' line giving a merge prophecy.",
    ].join(" ");
    return assembleReadingPrompt({
      methodName: "runes",
      symbols: symbolStrings,
      diff,
      extraSystem,
    });
  },
  render(symbols: DrawnSymbol[]) {
    return renderRunesAscii(symbols);
  },
};
