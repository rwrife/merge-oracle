import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ChatMessage } from "../llm/prompts.js";
import { assembleReadingPrompt } from "../llm/prompts.js";
import type { DivinationMethod, DrawnSymbol, MethodCallOptions, SpreadDescriptor } from "./types.js";
import type { DeckSchema, LoadedDeck } from "../data/decks/types.js";
import { DeckValidationError } from "../data/decks/types.js";

interface ArcanaCard {
  id: number;
  name: string;
  keywords: string[];
  upright: string;
  reversed: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = resolve(HERE, "../data/decks/major-arcana.json");

/**
 * Default bundled deck loaded eagerly from disk. Kept side-by-side with the
 * registry-loaded copy so tests that call `drawTarot(diff)` without going
 * through the registry still work exactly as before.
 */
const DEFAULT_DECK_CARDS: ArcanaCard[] = (
  JSON.parse(readFileSync(DECK_PATH, "utf8")) as { cards: ArcanaCard[] }
).cards;

/** Id of the bundled default tarot deck. */
export const DEFAULT_TAROT_DECK_ID = "major-arcana";

const THREE_CARD_SPREAD: ReadonlyArray<{ slot: string; gloss: string }> = [
  { slot: "Past",    gloss: "the karma of the base branch — what came before this change" },
  { slot: "Present", gloss: "the diff itself — the working ritual on the table" },
  { slot: "Future",  gloss: "the merge prophecy — what awaits if this PR sails through" },
];

/**
 * Classic 10-card Celtic Cross layout. Slot order matches the traditional
 * reading sequence (significator first, outcome last).
 */
const CELTIC_CROSS_SPREAD: ReadonlyArray<{ slot: string; gloss: string }> = [
  { slot: "Significator", gloss: "the heart of the PR — what this change truly is" },
  { slot: "Challenge",    gloss: "the obstacle crossing it — what stands in the way of merge" },
  { slot: "Foundation",   gloss: "the foundation beneath the change — base branch and history" },
  { slot: "Recent Past",  gloss: "events that birthed this PR — commits and prior reviews" },
  { slot: "Crown",        gloss: "the conscious goal — what the author hopes to ship" },
  { slot: "Near Future",  gloss: "what immediately follows — CI, review, the next push" },
  { slot: "Self",          gloss: "the author's posture — how they hold this branch" },
  { slot: "Environment",  gloss: "the team & reviewers — the room this PR lands in" },
  { slot: "Hopes/Fears",  gloss: "the silent omens — secret wishes and dreaded reviews" },
  { slot: "Outcome",      gloss: "the final merge prophecy — what is foretold" },
];

export type TarotSpreadId = "three-card" | "celtic-cross";

export const TAROT_SPREADS: ReadonlyArray<SpreadDescriptor> = [
  { id: "three-card",   name: "Past / Present / Future", cards: 3,  default: true },
  { id: "celtic-cross", name: "Celtic Cross",            cards: 10 },
];

function spreadSlots(id: TarotSpreadId): ReadonlyArray<{ slot: string; gloss: string }> {
  return id === "celtic-cross" ? CELTIC_CROSS_SPREAD : THREE_CARD_SPREAD;
}

function resolveSpread(opts?: MethodCallOptions): TarotSpreadId {
  const id = opts?.spread;
  if (id === "celtic-cross" || id === "three-card") return id;
  return "three-card";
}

/**
 * Per-method card schema exposed for the deck registry / validators. Unknown
 * fields are ignored; missing required fields throw a message the registry
 * annotates with the deck id.
 */
export const tarotDeckSchema: DeckSchema<ArcanaCard> = {
  method: "tarot",
  validateCard(raw: unknown, index: number): ArcanaCard {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new DeckValidationError(`card #${index}: expected an object`, { cardIndex: index });
    }
    const r = raw as Record<string, unknown>;
    const missing: string[] = [];
    const id = typeof r.id === "number" || typeof r.id === "string" ? (r.id as number | string) : null;
    const name = typeof r.name === "string" ? r.name : null;
    const upright = typeof r.upright === "string" ? r.upright : null;
    const reversed = typeof r.reversed === "string" ? r.reversed : null;
    const keywords = Array.isArray(r.keywords) && r.keywords.every((k) => typeof k === "string")
      ? (r.keywords as string[])
      : null;
    if (id === null) missing.push("id");
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
    // Normalize numeric ids to number when we can, but preserve strings so
    // custom decks with hyphenated ids ("the-fool") work unchanged.
    const normalizedId =
      typeof id === "string" && /^-?\d+$/.test(id) ? Number.parseInt(id, 10) : id;
    return {
      id: normalizedId as number,
      name: name!,
      upright: upright!,
      reversed: reversed!,
      keywords: keywords!,
    };
  },
};

/**
 * Resolve the deck to draw from. Priority:
 *   1. Explicit `opts.deck` (already loaded by the registry / caller).
 *   2. Bundled default deck (loaded once at module init).
 *
 * Validates cards on first use; validation results are cached per deck id so
 * repeated draws don't re-walk large decks.
 */
const VALIDATED: Map<string, ArcanaCard[]> = new Map();

function resolveDeckCards(opts?: MethodCallOptions): ArcanaCard[] {
  if (!opts?.deck) return DEFAULT_DECK_CARDS;
  return validateDeckOnce(opts.deck);
}

function validateDeckOnce(deck: LoadedDeck): ArcanaCard[] {
  const cached = VALIDATED.get(deck.id);
  if (cached) return cached;
  if (deck.method !== "tarot") {
    throw new DeckValidationError(
      `deck '${deck.id}' is for method '${deck.method}', not 'tarot'`,
      { deckId: deck.id },
    );
  }
  const cards: ArcanaCard[] = deck.cards.map((c, i) => {
    try {
      return tarotDeckSchema.validateCard(c, i);
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
      `deck '${deck.id}' has only ${cards.length} cards; tarot needs at least 3`,
      { deckId: deck.id },
    );
  }
  VALIDATED.set(deck.id, cards);
  return cards;
}

/**
 * Stable 32-bit hash of the diff. Drives reproducibility: the same diff
 * always pulls the same three cards in the same orientation.
 */
export function hashDiff(diff: string): number {
  const sum = createHash("sha256").update(diff).digest();
  return sum.readUInt32BE(0);
}

/**
 * Deterministically draw N distinct cards from the resolved deck.
 * Uses a Linear Congruential Generator seeded from the diff hash so the
 * same diff + spread always produces the same cards in the same orientation.
 */
export function drawTarot(diff: string, opts?: MethodCallOptions): DrawnSymbol[] {
  const spreadId = resolveSpread(opts);
  const slots = spreadSlots(spreadId);
  const cards = resolveDeckCards(opts);
  if (cards.length < slots.length) {
    throw new DeckValidationError(
      `deck '${opts?.deck?.id ?? "(default)"}' has ${cards.length} cards; spread '${spreadId}' needs ${slots.length}`,
      { deckId: opts?.deck?.id ?? null },
    );
  }
  // Preserve the original three-card seed for back-compat with snapshots;
  // mix the spread id into the seed only for alternate spreads so each
  // spread draws an independent shuffle from the same diff.
  const seedMix = spreadId === "three-card" ? 0 : djb2(spreadId);
  const seed = hashDiff(diff) ^ seedMix;
  let state = seed === 0 ? 1 : seed;
  const next = () => {
    // Numerical Recipes LCG; good enough for shuffling 22 cards.
    state = Math.imul(state, 1664525) + 1013904223;
    state = state >>> 0;
    return state;
  };

  const count = Math.min(slots.length, cards.length);
  const indices: number[] = [];
  while (indices.length < count) {
    const candidate = next() % cards.length;
    if (!indices.includes(candidate)) indices.push(candidate);
  }

  return indices.map((idx, i) => {
    const card = cards[idx];
    const reversed = (next() & 1) === 1;
    return {
      id: `arcana:${card.id}`,
      name: card.name,
      position: slots[i].slot,
      reversed,
      meta: {
        keywords: card.keywords,
        upright: card.upright,
        reversed: card.reversed,
        slotGloss: slots[i].gloss,
        spread: spreadId,
      },
    } satisfies DrawnSymbol;
  });
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function describeSymbol(s: DrawnSymbol): string {
  const meta = s.meta as { keywords: string[]; upright: string; reversed: string; slotGloss: string };
  const meaning = s.reversed ? meta.reversed : meta.upright;
  const orientation = s.reversed ? "reversed" : "upright";
  const kw = meta.keywords.join(", ");
  return `${s.position} — ${s.name} (${orientation}) [${kw}] :: ${meaning}`;
}

/**
 * Renders a tarot spread as ASCII art. Reversed cards are flipped.
 * Output is plain ASCII so snapshots stay stable across terminals.
 *
 * For 10-card spreads, lays out the classic Celtic Cross shape: a central
 * cross of six cards with a vertical staff of four cards on the right.
 */
export function renderTarotAscii(symbols: DrawnSymbol[]): string {
  if (symbols.length === 10) return renderCelticCross(symbols);
  return renderRow(symbols);
}

function renderRow(symbols: DrawnSymbol[]): string {
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

function renderCelticCross(symbols: DrawnSymbol[]): string {
  // Layout coordinates (in card units). Origin top-left.
  //   Cross block (columns 0..2, rows 0..2):
  //     row0:        . [Crown=4] .
  //     row1: [Past=3] [Sig=0+Chal=1] [Future=5]
  //     row2:        . [Found=2] .
  //   Staff (column 3, rows 0..3):
  //     [Hopes=8] [Env=7] [Self=6] [Outcome=9]
  // The challenge card (#1) overlays the significator (#0) by being drawn
  // beside it on the same row (we can't truly overlap in ASCII; we place
  // them side-by-side and mark the challenge with a `×` label).
  const cells: Record<string, DrawnSymbol | null> = {
    "0,1": symbols[3] ?? null,           // Past → left of center
    "1,0": symbols[4] ?? null,           // Crown → above center
    "1,1": symbols[0] ?? null,           // Significator → center
    "1,2": symbols[2] ?? null,           // Foundation → below center
    "2,1": symbols[5] ?? null,           // Near Future → right of center
    "3,0": symbols[8] ?? null,           // Hopes/Fears → staff top
    "3,1": symbols[7] ?? null,           // Environment
    "3,2": symbols[6] ?? null,           // Self
    "3,3": symbols[9] ?? null,           // Outcome → staff bottom
  };
  const challenge = symbols[1] ?? null;

  const COLS = 4;
  const ROWS = 4;
  const GAP_H = 2;
  const GAP_V = 1;
  const blank = Array.from({ length: CARD_H }, () => " ".repeat(CARD_W));

  const blockRows: string[] = [];
  for (let row = 0; row < ROWS; row++) {
    const colArt: string[][] = [];
    for (let col = 0; col < COLS; col++) {
      const sym = cells[`${col},${row}`];
      colArt.push(sym ? buildCard(sym) : blank);
    }
    for (let r = 0; r < CARD_H; r++) {
      blockRows.push(colArt.map((c) => c[r]).join(" ".repeat(GAP_H)));
    }
    for (let v = 0; v < GAP_V; v++) blockRows.push("");
  }

  const legend = symbols
    .map((s, i) => {
      const tag = i === 1 ? `${i + 1}× ${s.position}` : `${i + 1}. ${s.position}`;
      const orient = s.reversed ? "↯" : "✶";
      return `${tag.padEnd(20)} ${s.name} ${orient}`;
    })
    .join("\n");

  const challengeNote = challenge
    ? `\nCross (×) — ${challenge.name} ${challenge.reversed ? "(reversed)" : "(upright)"} lies across the Significator.\n`
    : "";

  return [blockRows.join("\n"), challengeNote, legend].join("\n");
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

/**
 * Reset the per-deck validation cache. Exposed for tests that mutate deck
 * fixtures between assertions; not part of the public runtime API.
 */
export function resetTarotDeckCache(): void {
  VALIDATED.clear();
}

export const tarot: DivinationMethod = {
  id: "tarot",
  name: "Tarot — Past / Present / Future (or Celtic Cross)",
  supportedSpreads: TAROT_SPREADS,
  describe() {
    return "draws Major Arcana cards seeded by the diff hash. Default three-card Past/Present/Future spread, with a 10-card Celtic Cross available for large PRs.";
  },
  draw(diff: string, opts?: MethodCallOptions) {
    return drawTarot(diff, opts);
  },
  readingPrompt(symbols: DrawnSymbol[], diff: string, opts?: MethodCallOptions): ChatMessage[] {
    const spreadId = resolveSpread(opts);
    const symbolStrings = symbols.map(describeSymbol);
    const deckLabel = opts?.deck ? ` (deck: ${opts.deck.name})` : "";
    const extraSystem =
      spreadId === "celtic-cross"
        ? [
            `You are reading a 10-card Celtic Cross Major Arcana spread${deckLabel} for a sizable pull request.`,
            "Address each slot in order (Significator, Challenge, Foundation, Recent Past, Crown,",
            "Near Future, Self, Environment, Hopes/Fears, Outcome) in one short sentence each,",
            "tying each card's meaning to something concrete in the diff.",
            "Close with a single 'Verdict:' line giving the final merge prophecy.",
          ].join(" ")
        : [
            `You are reading a 3-card Major Arcana tarot spread${deckLabel} for a pull request.`,
            "Address each slot in order (Past, Present, Future) in 1–2 sentences,",
            "tying each card's meaning to something concrete in the diff.",
            "Close with a single 'Verdict:' line giving a merge prophecy.",
          ].join(" ");
    return assembleReadingPrompt({
      methodName: spreadId === "celtic-cross" ? "tarot (celtic cross)" : "tarot",
      symbols: symbolStrings,
      diff,
      extraSystem,
      maxDiffChars: spreadId === "celtic-cross" ? 12000 : 8000,
    });
  },
  render(symbols: DrawnSymbol[]) {
    return renderTarotAscii(symbols);
  },
};
