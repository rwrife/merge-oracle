import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ChatMessage } from "../llm/prompts.js";
import { assembleReadingPrompt } from "../llm/prompts.js";
import type { DivinationMethod, DrawnSymbol } from "./types.js";

interface Hexagram {
  id: number;
  glyph: string;
  name: string;
  /** 6-char string of '1'/'0' read bottom line → top line. */
  binary: string;
  keywords: string[];
  meaning: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = resolve(HERE, "../data/decks/i-ching.json");
const HEXAGRAMS: Hexagram[] = JSON.parse(readFileSync(DECK_PATH, "utf8"));
const BY_BINARY = new Map(HEXAGRAMS.map((h) => [h.binary, h] as const));

/**
 * Each cast line is one of four traditional yarrow-stalk outcomes:
 *  - 6: old (changing) yin   → currently broken, becomes solid
 *  - 7: young yang           → solid, stable
 *  - 8: young yin            → broken, stable
 *  - 9: old (changing) yang  → currently solid, becomes broken
 *
 * Traditional yarrow probabilities (over 16 throws):
 *   old yin = 1, young yang = 5, young yin = 7, old yang = 3.
 * We preserve that distribution by mapping `byte % 16` into the table.
 */
const YARROW_TABLE: ReadonlyArray<6 | 7 | 8 | 9> = [
  6,
  7, 7, 7, 7, 7,
  8, 8, 8, 8, 8, 8, 8,
  9, 9, 9,
];

export interface CastLine {
  /** 1 = bottom line, 6 = top line. */
  position: number;
  value: 6 | 7 | 8 | 9;
  /** Yang (solid) before any change. */
  yangNow: boolean;
  /** Yang (solid) after any change. */
  yangFuture: boolean;
  /** True when this line is a "changing" line (6 or 9). */
  changing: boolean;
}

export interface IChingCast {
  primary: Hexagram;
  derived: Hexagram;
  /** Bottom-to-top, length 6. */
  lines: CastLine[];
  /** 1-indexed positions of changing lines, bottom-to-top. */
  changingPositions: number[];
}

function hashIChing(diff: string): Buffer {
  // Distinct domain separator so we don't lockstep with tarot/runes/tea-leaves.
  return createHash("sha256").update("i-ching\0").update(diff).digest();
}

/**
 * Cast a deterministic hexagram (with changing lines) from the diff.
 * Same diff → same six lines → same primary/derived hexagrams.
 */
export function castIChing(diff: string): IChingCast {
  const h = hashIChing(diff);
  const lines: CastLine[] = [];
  for (let i = 0; i < 6; i++) {
    const value = YARROW_TABLE[h[i] % YARROW_TABLE.length];
    const yangNow = value === 7 || value === 9;
    const yangFuture = value === 7 || value === 6;
    lines.push({
      position: i + 1,
      value,
      yangNow,
      yangFuture,
      changing: value === 6 || value === 9,
    });
  }

  const primaryBin = lines.map((l) => (l.yangNow ? "1" : "0")).join("");
  const derivedBin = lines.map((l) => (l.yangFuture ? "1" : "0")).join("");
  const primary = BY_BINARY.get(primaryBin);
  const derived = BY_BINARY.get(derivedBin);
  if (!primary || !derived) {
    throw new Error(`i-ching: missing hexagram for binary ${primaryBin}/${derivedBin}`);
  }

  return {
    primary,
    derived,
    lines,
    changingPositions: lines.filter((l) => l.changing).map((l) => l.position),
  };
}

const SLOTS = {
  primary: "Primary",
  derived: "Derived",
} as const;

/**
 * Cast a hexagram pair as DrawnSymbols.
 * Two symbols are returned: the Primary hexagram (current situation) and the
 * Derived hexagram (where the changing lines lead). If there are no changing
 * lines, only the Primary symbol is returned — by tradition, a stable cast
 * is read on the primary alone.
 */
export function drawIChing(diff: string): DrawnSymbol[] {
  const cast = castIChing(diff);
  const symbols: DrawnSymbol[] = [
    {
      id: `hexagram:${cast.primary.id}`,
      name: `${cast.primary.glyph} ${cast.primary.name}`,
      position: SLOTS.primary,
      meta: {
        hexagramId: cast.primary.id,
        glyph: cast.primary.glyph,
        hexagramName: cast.primary.name,
        binary: cast.primary.binary,
        keywords: cast.primary.keywords,
        meaning: cast.primary.meaning,
        lines: cast.lines,
        changingPositions: cast.changingPositions,
      },
    },
  ];

  if (cast.changingPositions.length > 0) {
    symbols.push({
      id: `hexagram:${cast.derived.id}`,
      name: `${cast.derived.glyph} ${cast.derived.name}`,
      position: SLOTS.derived,
      meta: {
        hexagramId: cast.derived.id,
        glyph: cast.derived.glyph,
        hexagramName: cast.derived.name,
        binary: cast.derived.binary,
        keywords: cast.derived.keywords,
        meaning: cast.derived.meaning,
        changingPositions: cast.changingPositions,
      },
    });
  }

  return symbols;
}

function lineGlyph(line: CastLine): string {
  // Solid (yang) or broken (yin); a small "x" or "o" suffix marks changing lines
  // (yin→yang or yang→yin respectively, in keeping with traditional notation).
  if (line.value === 6) return "— —  x";   // old yin, becoming yang
  if (line.value === 7) return "—————   ";  // young yang
  if (line.value === 8) return "— —     ";  // young yin
  return "—————  o";                          // old yang (9), becoming yin
}

/**
 * Render the cast: two hexagrams side-by-side (primary | derived), drawn
 * top line first as is traditional, with changing-line markers between them.
 */
export function renderIChing(symbols: DrawnSymbol[]): string {
  const primary = symbols[0];
  const derived = symbols[1];
  const meta = primary.meta as { lines: CastLine[]; hexagramName: string; glyph: string };
  const lines = meta.lines;

  const leftRows: string[] = [];
  // Print top line first (position 6 → position 1).
  for (let i = lines.length - 1; i >= 0; i--) {
    leftRows.push(lineGlyph(lines[i]));
  }

  if (!derived) {
    const header = `${meta.glyph}  ${meta.hexagramName}`;
    return [header, "", ...leftRows, "", "(no changing lines — read the primary only)"].join("\n");
  }

  const dMeta = derived.meta as { lines?: CastLine[]; hexagramName: string; glyph: string };
  // Build the derived column lines (solid for yangFuture, broken for yinFuture).
  const derivedRows: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    derivedRows.push(lines[i].yangFuture ? "—————" : "— —  ");
  }

  const arrow = "  ⇒  ";
  const header =
    `${meta.glyph} ${meta.hexagramName}` +
    `${" ".repeat(Math.max(2, 22 - meta.hexagramName.length))}` +
    `${dMeta.glyph} ${dMeta.hexagramName}`;

  const rows: string[] = [];
  for (let i = 0; i < leftRows.length; i++) {
    rows.push(`${leftRows[i].padEnd(12)}${arrow}${derivedRows[i]}`);
  }
  return [header, "", ...rows].join("\n");
}

function describeSymbol(s: DrawnSymbol): string {
  const meta = s.meta as {
    hexagramName: string;
    keywords: string[];
    meaning: string;
    changingPositions?: number[];
  };
  const kw = meta.keywords.join(", ");
  const cl =
    meta.changingPositions && meta.changingPositions.length > 0
      ? ` [changing lines: ${meta.changingPositions.join(", ")}]`
      : "";
  return `${s.position} — ${meta.hexagramName}${cl} [${kw}] :: ${meta.meaning}`;
}

export const iChing: DivinationMethod = {
  id: "i-ching",
  name: "I-Ching — hexagram cast from the diff",
  describe() {
    return "casts a hexagram (and, when lines are changing, a derived hexagram) seeded by the diff hash and reads the transformation as a merge prophecy.";
  },
  draw(diff: string) {
    return drawIChing(diff);
  },
  readingPrompt(symbols: DrawnSymbol[], diff: string): ChatMessage[] {
    const symbolStrings = symbols.map(describeSymbol);
    const hasDerived = symbols.length > 1;
    const extraSystem = [
      "You are reading a Yi Jing (I-Ching) cast for a pull request.",
      "Speak of the Primary hexagram as the diff's present nature (1–2 sentences),",
      hasDerived
        ? "then of the Derived hexagram as where the changing lines lead this merge (1–2 sentences),"
        : "(no changing lines — read the Primary alone, do not invent a Derived,)",
      "tying each hexagram's meaning to something concrete in the diff.",
      "Close with a single 'Verdict:' line giving the merge prophecy.",
    ].join(" ");
    return assembleReadingPrompt({
      methodName: "i-ching",
      symbols: symbolStrings,
      diff,
      extraSystem,
    });
  },
  render(symbols: DrawnSymbol[]) {
    return renderIChing(symbols);
  },
};
