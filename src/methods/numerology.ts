import type { ChatMessage } from "../llm/prompts.js";
import { assembleReadingPrompt } from "../llm/prompts.js";
import type { DivinationMethod, DrawnSymbol } from "./types.js";
import { parseDiffStats, type DiffStats } from "./teaLeaves.js";

/**
 * Numerology — read the *numbers* of a diff.
 *
 * Pure arithmetic mysticism: no hashes, no random streams, no LLM
 * required to derive the symbols. We collect four counts from the diff
 * and reduce each one via classic digit-sum-mod-9, preserving the
 * three master numbers (11, 22, 33).
 */

export type NumerologyPosition =
  | "Life Path"
  | "Expression"
  | "Soul Urge"
  | "Personality";

const MASTER_NUMBERS: ReadonlySet<number> = new Set([11, 22, 33]);

interface MeaningBlurb {
  keyword: string;
  meaning: string;
}

/**
 * Fixed meaning table. Indices 1..9 are the reduced digits;
 * 11/22/33 are the preserved master numbers. 0 is the empty cup.
 */
const MEANINGS: Record<number, MeaningBlurb> = {
  0: {
    keyword: "the void",
    meaning: "no churn, no signal — an empty cup, awaiting the first stroke.",
  },
  1: { keyword: "leadership / disruption", meaning: "a bold opening move; this PR plants a flag." },
  2: { keyword: "partnership / review",    meaning: "balance and dialogue; this change wants a co-signer." },
  3: { keyword: "expression / chatter",    meaning: "energetic, scattered output; expect comments." },
  4: { keyword: "foundation / scaffolding",meaning: "load-bearing work; tests and structure matter here." },
  5: { keyword: "change / volatility",     meaning: "restless movement; the diff stirs more than it settles." },
  6: { keyword: "harmony / refactor",      meaning: "tidying and care; this PR seeks order, not novelty." },
  7: { keyword: "introspection / refactor",meaning: "quiet, internal work; reviewers will need to read slowly." },
  8: { keyword: "power / scale",           meaning: "consequential reach; this PR moves real weight." },
  9: { keyword: "completion / closure",    meaning: "an ending arc; something is being finished or removed." },
  11:{ keyword: "the visionary (master)",  meaning: "a master omen — intuition outpaces logic; review with care." },
  22:{ keyword: "the architect (master)",  meaning: "a master omen — sweeping construction; weight-bearing change." },
  33:{ keyword: "the teacher (master)",    meaning: "a master omen — instructive change; others will learn from this." },
};

const SPREAD: ReadonlyArray<{ slot: NumerologyPosition; gloss: string }> = [
  { slot: "Life Path",   gloss: "from total churn (additions + deletions) — the PR's destiny" },
  { slot: "Expression",  gloss: "from files touched — how the PR shows itself to the world" },
  { slot: "Soul Urge",   gloss: "from hunk count — the inner motive driving the change" },
  { slot: "Personality", gloss: "from the longest contiguous run of additions — its outward face" },
];

/**
 * Classic numerological reduction:
 *  - Sum digits repeatedly until a single digit (1..9) remains.
 *  - Stop early when the running sum is a master number (11, 22, 33)
 *    so master numbers are *not* reduced further.
 *  - 0 (and negative inputs, which can't occur here) collapses to 0.
 */
export function reduceNumber(n: number): number {
  let v = Math.abs(Math.trunc(n));
  if (v === 0) return 0;
  while (v > 9) {
    if (MASTER_NUMBERS.has(v)) return v;
    let s = 0;
    while (v > 0) {
      s += v % 10;
      v = Math.floor(v / 10);
    }
    v = s;
  }
  return v;
}

/** Longest contiguous run of `+` lines in the diff body (excludes `+++` headers). */
export function longestAdditionRun(diff: string): number {
  let best = 0;
  let cur = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++")) {
      cur = 0;
      continue;
    }
    if (line.startsWith("+")) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

export interface NumerologyChart {
  lifePath: number;
  expression: number;
  soulUrge: number;
  personality: number;
  /** The raw inputs before reduction, for transparency. */
  raw: {
    churn: number;
    files: number;
    hunks: number;
    longestRun: number;
  };
  stats: DiffStats;
}

export function computeChart(diff: string): NumerologyChart {
  const stats = parseDiffStats(diff);
  const churn = stats.additions + stats.deletions;
  const longest = longestAdditionRun(diff);
  return {
    lifePath: reduceNumber(churn),
    expression: reduceNumber(stats.files),
    soulUrge: reduceNumber(stats.hunks),
    personality: reduceNumber(longest),
    raw: {
      churn,
      files: stats.files,
      hunks: stats.hunks,
      longestRun: longest,
    },
    stats,
  };
}

export function castNumerology(diff: string): DrawnSymbol[] {
  const chart = computeChart(diff);
  const numbers = [chart.lifePath, chart.expression, chart.soulUrge, chart.personality];
  return SPREAD.map((slot, i) => {
    const n = numbers[i];
    const blurb = MEANINGS[n] ?? MEANINGS[0];
    return {
      id: `num:${slot.slot.toLowerCase().replace(/\s+/g, "-")}:${n}`,
      name: `${slot.slot} ${n}`,
      position: slot.slot,
      meta: {
        number: n,
        master: MASTER_NUMBERS.has(n),
        keyword: blurb.keyword,
        meaning: blurb.meaning,
        slotGloss: slot.gloss,
        raw: chart.raw,
        stats: chart.stats,
      },
    };
  });
}

function describeSymbol(s: DrawnSymbol): string {
  const meta = s.meta as { number: number; keyword: string; meaning: string; master?: boolean };
  const tag = meta.master ? " (MASTER)" : "";
  return `${s.position} = ${meta.number}${tag} — ${meta.keyword} :: ${meta.meaning}`;
}

const CELL_W = 13;

function padCell(text: string): string {
  const inner = CELL_W - 2;
  const t = text.length > inner ? text.slice(0, inner) : text;
  const left = Math.floor((inner - t.length) / 2);
  const right = inner - t.length - left;
  return " " + " ".repeat(left) + t + " ".repeat(right) + " ";
}

/**
 * Render a 4-square ASCII chart:
 *
 *   +-------------+-------------+
 *   |  Life Path  | Expression  |
 *   |      9      |      4      |
 *   +-------------+-------------+
 *   |  Soul Urge  | Personality |
 *   |     11★     |      7      |
 *   +-------------+-------------+
 */
export function renderNumerologyAscii(symbols: DrawnSymbol[]): string {
  const cells = symbols.map((s) => {
    const meta = s.meta as { number: number; master?: boolean };
    return { label: s.position, value: meta.master ? `${meta.number}★` : `${meta.number}` };
  });
  while (cells.length < 4) cells.push({ label: "—", value: "—" });

  const divider = "+" + "-".repeat(CELL_W) + "+" + "-".repeat(CELL_W) + "+";
  const labelRow = (a: typeof cells[number], b: typeof cells[number]) =>
    "|" + padCell(a.label) + "|" + padCell(b.label) + "|";
  const valueRow = (a: typeof cells[number], b: typeof cells[number]) =>
    "|" + padCell(a.value) + "|" + padCell(b.value) + "|";

  const stats = symbols[0]?.meta as { raw?: NumerologyChart["raw"] } | undefined;
  const raw = stats?.raw;
  const footer = raw
    ? `inputs: churn=${raw.churn}, files=${raw.files}, hunks=${raw.hunks}, longest+run=${raw.longestRun}`
    : "";

  return [
    divider,
    labelRow(cells[0], cells[1]),
    valueRow(cells[0], cells[1]),
    divider,
    labelRow(cells[2], cells[3]),
    valueRow(cells[2], cells[3]),
    divider,
    "",
    footer,
  ]
    .filter((l, i, arr) => !(l === "" && i === arr.length - 1))
    .join("\n");
}

export const numerology: DivinationMethod = {
  id: "numerology",
  name: "Numerology — Life Path / Expression / Soul Urge / Personality",
  describe() {
    return "reduces the diff's own numbers — churn, files, hunks, longest run of additions — into four numerological digits (master numbers 11/22/33 preserved), then weaves them into a merge prophecy.";
  },
  draw(diff: string) {
    return castNumerology(diff);
  },
  readingPrompt(symbols: DrawnSymbol[], diff: string): ChatMessage[] {
    const symbolStrings = symbols.map(describeSymbol);
    const meta0 = symbols[0]?.meta as { raw?: NumerologyChart["raw"] } | undefined;
    const raw = meta0?.raw;
    const inputsLine = raw
      ? `Raw inputs: churn=${raw.churn} (adds+deletes), files=${raw.files}, hunks=${raw.hunks}, longest contiguous addition run=${raw.longestRun}.`
      : "Raw inputs: (none — empty diff).";
    const extraSystem = [
      "You are reading the numerology chart of a pull request.",
      "Address each of the four numbers in order (Life Path, Expression, Soul Urge, Personality) in 1–2 sentences each,",
      "weaving their meanings into a single coherent prophecy that respects the actual diff.",
      "Call out master numbers (11/22/33) explicitly when they appear.",
      inputsLine,
      "Close with a single 'Verdict:' line giving a merge prophecy.",
    ].join(" ");
    return assembleReadingPrompt({
      methodName: "numerology",
      symbols: symbolStrings,
      diff,
      extraSystem,
    });
  },
  render(symbols: DrawnSymbol[]) {
    return renderNumerologyAscii(symbols);
  },
};

export default numerology;
