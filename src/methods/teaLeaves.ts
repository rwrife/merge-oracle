import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ChatMessage } from "../llm/prompts.js";
import { assembleReadingPrompt } from "../llm/prompts.js";
import type { DivinationMethod, DrawnSymbol } from "./types.js";

interface TeaShape {
  id: string;
  glyph: string;
  name: string;
  keywords: string[];
  meaning: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = resolve(HERE, "../data/decks/tea-leaves.json");
const SHAPES: TeaShape[] = (JSON.parse(readFileSync(DECK_PATH, "utf8")) as { cards: TeaShape[] }).cards;
const BY_ID = new Map(SHAPES.map((s) => [s.id, s]));

/**
 * Tea-leaf reading slots map to layers of a cup. By tradition, leaves
 * resting near the rim concern matters close at hand, the sides reflect
 * the present work, and the bottom hints at distant consequences.
 */
const SPREAD: ReadonlyArray<{ slot: string; gloss: string }> = [
  { slot: "Rim",    gloss: "what is closest — the imminent reviewer reaction" },
  { slot: "Side",   gloss: "the substance of the diff itself, the work on the table" },
  { slot: "Bottom", gloss: "the distant consequence — what this change foreshadows" },
];

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  hunks: number;
  /** Largest contiguous hunk size in lines. */
  maxHunkLines: number;
  /** Net signed delta (additions - deletions). */
  net: number;
  /** Ratio of additions to total churn, in [0, 1]; 0.5 means balanced. */
  addRatio: number;
  /** Unique top-level directories touched. */
  dirs: number;
}

const FILE_HEADER = /^diff --git a\/(\S+) b\/(\S+)/;
const HUNK_HEADER = /^@@ /;

/**
 * Tiny structural diff parser. We don't need full unified-diff semantics —
 * just counts that capture the "shape" of the change for divination.
 */
export function parseDiffStats(diff: string): DiffStats {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  let curHunk = 0;
  let maxHunkLines = 0;
  const dirSet = new Set<string>();

  const flushHunk = () => {
    if (curHunk > maxHunkLines) maxHunkLines = curHunk;
    curHunk = 0;
  };

  for (const line of diff.split(/\r?\n/)) {
    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      flushHunk();
      files += 1;
      const path = fileMatch[2];
      const top = path.split("/")[0] || path;
      dirSet.add(top);
      continue;
    }
    if (HUNK_HEADER.test(line)) {
      flushHunk();
      hunks += 1;
      continue;
    }
    // Ignore the +++ / --- headers themselves.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      additions += 1;
      curHunk += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
      curHunk += 1;
    }
  }
  flushHunk();

  const churn = additions + deletions;
  const addRatio = churn === 0 ? 0.5 : additions / churn;
  return {
    files,
    additions,
    deletions,
    hunks,
    maxHunkLines,
    net: additions - deletions,
    addRatio,
    dirs: dirSet.size,
  };
}

/**
 * Score each shape against the diff stats. Higher = more "visible" in the cup.
 * Scores are deterministic functions of the stats — the diff hash is then
 * used only to break ties and to choose slot ordering.
 */
export function scoreShapes(stats: DiffStats): Map<string, number> {
  const scores = new Map<string, number>();
  const churn = stats.additions + stats.deletions;

  const bump = (id: string, n: number) => scores.set(id, (scores.get(id) ?? 0) + n);

  // Size shapes.
  if (churn === 0) bump("cloud", 5);
  if (churn > 0 && churn < 10) bump("drop", 4);
  if (churn >= 200) bump("mountain", 4);
  if (churn >= 500) bump("mountain", 2);

  // Balance shapes.
  if (churn >= 10 && stats.addRatio >= 0.4 && stats.addRatio <= 0.6) bump("scales", 4);
  if (stats.addRatio >= 0.9 && churn >= 10) bump("tower", 3);
  if (stats.deletions > stats.additions * 2 && stats.deletions >= 10) bump("knife", 4);
  if (stats.net > 0 && stats.deletions === 0 && churn >= 5) bump("key", 2);

  // File-shape shapes.
  if (stats.files === 1) bump("path", 3);
  if (stats.files >= 5) bump("tree", 3);
  if (stats.files >= 10) bump("web", 3);
  if (stats.dirs >= 3) bump("crossroads", 3);

  // Hunk topology.
  if (stats.hunks >= 8) bump("spiral", 3);
  if (stats.hunks <= 2 && churn >= 5) bump("star", 2);
  if (stats.maxHunkLines >= 80) bump("lightning", 3);
  if (stats.hunks >= 3 && stats.maxHunkLines <= 10) bump("ring", 2);

  // Vibe shapes — always in the running so small diffs still produce a cast.
  bump("snake", 1);
  bump("crescent", 1);
  bump("anchor", 1);
  bump("bird", 1);
  bump("heart", 1);

  return scores;
}

function hashTeaLeaves(diff: string): number {
  // Read a different byte slice from tarot/runes so methods don't synchronize.
  return createHash("sha256").update(diff).digest().readUInt32BE(8);
}

/**
 * Deterministically pick three distinct shapes from the cup. Selection is
 * primarily driven by stats-based scores; ties are broken by a diff-hash
 * stream so the cast stays reproducible.
 */
export function readLeaves(diff: string): DrawnSymbol[] {
  const stats = parseDiffStats(diff);
  const scores = scoreShapes(stats);

  let state = hashTeaLeaves(diff);
  if (state === 0) state = 0x6d2b79f5;
  const next = () => {
    // Mulberry32 — good distribution, distinct from tarot LCG and rune xorshift.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };

  // Sort by (score desc, tiebreaker from hash, then stable id).
  const ranked = SHAPES.map((s) => {
    const tieBreak = next();
    return { shape: s, score: scores.get(s.id) ?? 0, tieBreak };
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.tieBreak !== b.tieBreak) return a.tieBreak - b.tieBreak;
    return a.shape.id.localeCompare(b.shape.id);
  });

  const picks = ranked.slice(0, 3).map((r) => r.shape);

  return picks.map((shape, i) => ({
    id: `leaf:${shape.id}`,
    name: `${shape.glyph} ${shape.name}`,
    position: SPREAD[i].slot,
    meta: {
      glyph: shape.glyph,
      shapeName: shape.name,
      keywords: shape.keywords,
      meaning: shape.meaning,
      slotGloss: SPREAD[i].gloss,
      stats,
      score: scores.get(shape.id) ?? 0,
    },
  }));
}

function describeSymbol(s: DrawnSymbol): string {
  const meta = s.meta as {
    shapeName: string;
    keywords: string[];
    meaning: string;
    slotGloss: string;
  };
  return `${s.position} — ${meta.shapeName} [${meta.keywords.join(", ")}] :: ${meta.meaning}`;
}

const CUP_W = 21;

/**
 * Render an ASCII teacup with three drawn shapes inside, plus a stats
 * footer so the cast is legible without an LLM reading.
 */
export function renderTeaLeavesAscii(symbols: DrawnSymbol[]): string {
  const glyphs = symbols.map((s) => {
    const meta = s.meta as { glyph: string };
    return meta.glyph;
  });
  const [rim, side, bottom] = glyphs;
  const stats = symbols[0]?.meta as { stats?: DiffStats } | undefined;
  const inner = CUP_W - 2;

  const rimLine    = "(" + centerPad(rim ?? " ", inner) + ")";
  const sideLine   = "|" + centerPad(side ?? " ", inner) + "|";
  const bottomLine = " \\" + centerPad(bottom ?? " ", inner - 2) + "/";
  const saucer     = "  " + "~".repeat(inner - 2) + "  ";

  const lines = [
    " " + "_".repeat(inner) + " ",
    rimLine,
    "|" + " ".repeat(inner) + "|",
    sideLine,
    "|" + " ".repeat(inner) + "|",
    bottomLine,
    saucer,
  ];

  const labels = symbols
    .map((s) => {
      const meta = s.meta as { shapeName: string };
      return `${s.position}: ${meta.shapeName}`;
    })
    .join("  ·  ");

  const footer = stats?.stats
    ? `stats: ${stats.stats.files} file(s), +${stats.stats.additions}/-${stats.stats.deletions}, ${stats.stats.hunks} hunk(s)`
    : "";

  return [lines.join("\n"), "", labels, footer].filter(Boolean).join("\n");
}

function centerPad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

// Re-export the deck lookup for tests that want to assert against meanings.
export function _shapeById(id: string): TeaShape | undefined {
  return BY_ID.get(id);
}

export const teaLeaves: DivinationMethod = {
  id: "tea-leaves",
  name: "Tea Leaves — Rim / Side / Bottom",
  describe() {
    return "reads the shape of the diff itself — file count, +/- ratio, hunk topology — as three leaf-shapes settled in a cup: Rim (imminent), Side (the work), Bottom (distant consequence).";
  },
  draw(diff: string) {
    return readLeaves(diff);
  },
  readingPrompt(symbols: DrawnSymbol[], diff: string): ChatMessage[] {
    const symbolStrings = symbols.map(describeSymbol);
    const stats = symbols[0]?.meta as { stats?: DiffStats } | undefined;
    const statsLine = stats?.stats
      ? `Cup-shape stats: ${stats.stats.files} file(s) across ${stats.stats.dirs} dir(s), +${stats.stats.additions}/-${stats.stats.deletions} over ${stats.stats.hunks} hunk(s); largest hunk ${stats.stats.maxHunkLines} lines.`
      : "Cup-shape stats: (none — empty cup).";
    const extraSystem = [
      "You are reading tea leaves left by a pull request.",
      "Address each shape in order (Rim, Side, Bottom) in 1–2 sentences,",
      "tying each shape to the actual diff stats and the changes you see.",
      statsLine,
      "Close with a single 'Verdict:' line giving a merge prophecy.",
    ].join(" ");
    return assembleReadingPrompt({
      methodName: "tea-leaves",
      symbols: symbolStrings,
      diff,
      extraSystem,
    });
  },
  render(symbols: DrawnSymbol[]) {
    return renderTeaLeavesAscii(symbols);
  },
};
