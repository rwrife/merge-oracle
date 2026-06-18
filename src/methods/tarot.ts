import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ChatMessage } from "../llm/prompts.js";
import { assembleReadingPrompt } from "../llm/prompts.js";
import type { DivinationMethod, DrawnSymbol } from "./types.js";

interface ArcanaCard {
  id: number;
  name: string;
  keywords: string[];
  upright: string;
  reversed: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = resolve(HERE, "../data/decks/major-arcana.json");
const ARCANA: ArcanaCard[] = JSON.parse(readFileSync(DECK_PATH, "utf8"));
const SPREAD: ReadonlyArray<{ slot: string; gloss: string }> = [
  { slot: "Past",    gloss: "the karma of the base branch — what came before this change" },
  { slot: "Present", gloss: "the diff itself — the working ritual on the table" },
  { slot: "Future",  gloss: "the merge prophecy — what awaits if this PR sails through" },
];

/**
 * Stable 32-bit hash of the diff. Drives reproducibility: the same diff
 * always pulls the same three cards in the same orientation.
 */
export function hashDiff(diff: string): number {
  const sum = createHash("sha256").update(diff).digest();
  return sum.readUInt32BE(0);
}

/**
 * Deterministically draw three distinct cards from a 22-card deck.
 * Uses a Linear Congruential Generator seeded from the diff hash.
 */
export function drawTarot(diff: string): DrawnSymbol[] {
  const seed = hashDiff(diff);
  let state = seed === 0 ? 1 : seed;
  const next = () => {
    // Numerical Recipes LCG; good enough for shuffling 22 cards.
    state = Math.imul(state, 1664525) + 1013904223;
    state = state >>> 0;
    return state;
  };

  const indices: number[] = [];
  while (indices.length < 3) {
    const candidate = next() % ARCANA.length;
    if (!indices.includes(candidate)) indices.push(candidate);
  }

  return indices.map((idx, i) => {
    const card = ARCANA[idx];
    const reversed = (next() & 1) === 1;
    return {
      id: `arcana:${card.id}`,
      name: card.name,
      position: SPREAD[i].slot,
      reversed,
      meta: {
        keywords: card.keywords,
        upright: card.upright,
        reversed: card.reversed,
        slotGloss: SPREAD[i].gloss,
      },
    } satisfies DrawnSymbol;
  });
}

function describeSymbol(s: DrawnSymbol): string {
  const meta = s.meta as { keywords: string[]; upright: string; reversed: string; slotGloss: string };
  const meaning = s.reversed ? meta.reversed : meta.upright;
  const orientation = s.reversed ? "reversed" : "upright";
  const kw = meta.keywords.join(", ");
  return `${s.position} — ${s.name} (${orientation}) [${kw}] :: ${meaning}`;
}

/**
 * Renders a 3-card tarot spread as ASCII art. Reversed cards are flipped.
 * Output is plain ASCII so snapshots stay stable across terminals.
 */
export function renderTarotAscii(symbols: DrawnSymbol[]): string {
  const cards = symbols.map((s) => buildCard(s));
  const height = cards[0].length;
  const rows: string[] = [];
  for (let r = 0; r < height; r++) {
    rows.push(cards.map((c) => c[r]).join("  "));
  }
  const labels = symbols
    .map((s) => {
      const orient = s.reversed ? "↯" : "✶";
      return centerPad(`${s.position}: ${s.name} ${orient}`, 18);
    })
    .join("  ");
  return [rows.join("\n"), "", labels].join("\n");
}

const CARD_W = 18;
const CARD_H = 9;

function buildCard(s: DrawnSymbol): string[] {
  const meta = s.meta as { keywords: string[] };
  const lines: string[] = [];
  lines.push("+" + "-".repeat(CARD_W - 2) + "+");
  lines.push(padCard(s.position));
  lines.push(padCard(""));
  lines.push(padCard(truncate(s.name, CARD_W - 4)));
  lines.push(padCard(truncate(meta.keywords[0] ?? "", CARD_W - 4)));
  lines.push(padCard(truncate(meta.keywords[1] ?? "", CARD_W - 4)));
  lines.push(padCard(""));
  lines.push(padCard(s.reversed ? "(reversed)" : "(upright)"));
  lines.push("+" + "-".repeat(CARD_W - 2) + "+");
  while (lines.length < CARD_H) lines.push(padCard(""));
  return s.reversed ? flipCard(lines) : lines;
}

function flipCard(lines: string[]): string[] {
  // Visually invert: reverse line order and reverse the inner text of each line.
  return [...lines].reverse().map((ln) => {
    if (ln.startsWith("+")) return ln; // border line — symmetric already
    const inner = ln.slice(1, -1);
    return "|" + inner.split("").reverse().join("") + "|";
  });
}

function padCard(text: string): string {
  const inner = centerPad(text, CARD_W - 2);
  return "|" + inner + "|";
}

function centerPad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

export const tarot: DivinationMethod = {
  id: "tarot",
  name: "Tarot — Past / Present / Future",
  describe() {
    return "draws three Major Arcana cards seeded by the diff hash and reads them as Past, Present, and Future of the merge.";
  },
  draw(diff: string) {
    return drawTarot(diff);
  },
  readingPrompt(symbols: DrawnSymbol[], diff: string): ChatMessage[] {
    const symbolStrings = symbols.map(describeSymbol);
    const extraSystem = [
      "You are reading a 3-card Major Arcana tarot spread for a pull request.",
      "Address each slot in order (Past, Present, Future) in 1–2 sentences,",
      "tying each card's meaning to something concrete in the diff.",
      "Close with a single 'Verdict:' line giving a merge prophecy.",
    ].join(" ");
    return assembleReadingPrompt({
      methodName: "tarot",
      symbols: symbolStrings,
      diff,
      extraSystem,
    });
  },
  render(symbols: DrawnSymbol[]) {
    return renderTarotAscii(symbols);
  },
};
