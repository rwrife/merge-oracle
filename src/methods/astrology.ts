import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ChatMessage } from "../llm/prompts.js";
import { assembleReadingPrompt } from "../llm/prompts.js";
import type { DivinationMethod, DrawnSymbol } from "./types.js";

/**
 * Astrology — casts a natal chart for the pull request itself.
 *
 * Three signs are drawn:
 *   • Sun    — the diff's own creation timestamp (parsed from a `Date:`
 *              header when the diff carries one, else derived from the
 *              diff hash so the reading is reproducible offline).
 *   • Moon   — the commit author's birthday, taken from
 *              `git config user.birthday` if set (YYYY-MM-DD or MM-DD),
 *              else synthesized deterministically from `git config
 *              user.email`, else from the diff hash.
 *   • Rising — the base branch name plus the repo name, so the same PR
 *              looks different against `main` vs `release/*`. Falls back
 *              to `git config` lookups, then the diff hash.
 *
 * Same diff + same environment → same chart. No live GitHub metadata is
 * required beyond what already ships in the diff or the local git config.
 */

interface ZodiacSign {
  id: string;
  glyph: string;
  name: string;
  element: string;
  modality: string;
  ruler: string;
  keywords: string[];
  delineation: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = resolve(HERE, "../data/decks/zodiac.json");
const ZODIAC: ZodiacSign[] = (JSON.parse(readFileSync(DECK_PATH, "utf8")) as { cards: ZodiacSign[] }).cards;
const BY_ID = new Map(ZODIAC.map((s) => [s.id, s]));

const SPREAD: ReadonlyArray<{ slot: "Sun" | "Moon" | "Rising"; gloss: string }> = [
  { slot: "Sun",    gloss: "the diff's core identity — cast from its creation timestamp" },
  { slot: "Moon",   gloss: "the author's inner tide — cast from their birthday (real or synthesized)" },
  { slot: "Rising", gloss: "the ascendant mask — cast from the base branch and repo" },
];

/**
 * Deterministic domain-separated hash so astrology never draws lockstep
 * with tarot/runes/tea-leaves/i-ching/numerology on the same diff.
 */
function astroHash(diff: string, tag: string): Buffer {
  return createHash("sha256").update(`astrology\0${tag}\0`).update(diff).digest();
}

/**
 * Solar longitude → zodiac sign, using the standard tropical zodiac
 * boundaries. Any Date (any year) yields a sign; we ignore hour/minute
 * because acceptance is day-granularity per the issue's out-of-scope note.
 *
 * Returns the zodiac id (e.g. "aries").
 */
export function signFromDate(date: Date): string {
  const m = date.getUTCMonth() + 1; // 1..12
  const d = date.getUTCDate();       // 1..31
  const cutoffs: ReadonlyArray<{ month: number; day: number; id: string }> = [
    { month:  1, day:  1, id: "capricorn"   },
    { month:  1, day: 20, id: "aquarius"    },
    { month:  2, day: 19, id: "pisces"      },
    { month:  3, day: 21, id: "aries"       },
    { month:  4, day: 20, id: "taurus"      },
    { month:  5, day: 21, id: "gemini"      },
    { month:  6, day: 21, id: "cancer"      },
    { month:  7, day: 23, id: "leo"         },
    { month:  8, day: 23, id: "virgo"       },
    { month:  9, day: 23, id: "libra"       },
    { month: 10, day: 23, id: "scorpio"     },
    { month: 11, day: 22, id: "sagittarius" },
    { month: 12, day: 22, id: "capricorn"   },
  ];
  let pick = cutoffs[0].id;
  for (const c of cutoffs) {
    if (m > c.month || (m === c.month && d >= c.day)) pick = c.id;
    else break;
  }
  return pick;
}

/**
 * Extract a `Date:` header from a diff (git format-patch style):
 *   Date: Mon, 3 Jul 2026 17:21:27 +0000
 * Returns a Date or null. Only the first such header is used.
 */
export function parseDiffDate(diff: string): Date | null {
  for (const line of diff.split(/\r?\n/, 500)) {
    const m = /^Date:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isNaN(t)) return new Date(t);
  }
  return null;
}

/**
 * Hash-derived synthetic date for the Sun slot when the diff has no
 * Date header. Deterministic across runs; produces a day-of-year in
 * [1..365] mapped onto year 2000 (a leap year → 366 is safely reachable
 * but we clamp to 365 to avoid Feb-29 edge cases).
 */
export function syntheticSunDate(diff: string): Date {
  const h = astroHash(diff, "sun").readUInt32BE(0);
  const doy = (h % 365) + 1;
  const base = Date.UTC(2000, 0, 1); // Jan 1, 2000 UTC
  return new Date(base + (doy - 1) * 86_400_000);
}

/**
 * Parse `git config user.birthday` values. Accepts:
 *   YYYY-MM-DD
 *   MM-DD
 * Rejects anything else. Returns a Date in year 2000 for MM-DD form so
 * downstream sign lookup is stable.
 */
export function parseBirthday(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  let m: RegExpExecArray | null;
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return new Date(Date.UTC(y, mo - 1, d));
    }
    return null;
  }
  m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return new Date(Date.UTC(2000, mo - 1, d));
    }
  }
  return null;
}

/**
 * Deterministic date synthesized from an arbitrary string (email, branch
 * name, repo name, …). Used when git config lookups fail so the reading
 * stays reproducible offline.
 */
export function syntheticDateFromString(seed: string, tag: string): Date {
  const h = createHash("sha256").update(`${tag}\0`).update(seed).digest();
  const doy = (h.readUInt32BE(0) % 365) + 1;
  return new Date(Date.UTC(2000, 0, 1) + (doy - 1) * 86_400_000);
}

/** Safe wrapper around `git config <key>` — returns null on any failure. */
export function readGitConfig(key: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const out = execFileSync("git", ["config", "--get", key], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    })
      .toString()
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Repo hint used by the Rising slot. Prefers the remote URL's last path
 * segment (e.g. "merge-oracle" from
 * "git@github.com:rwrife/merge-oracle.git"), else the toplevel directory
 * basename. Null when neither is available.
 */
export function readRepoName(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = readGitConfig("remote.origin.url", env);
  if (url) {
    const cleaned = url.replace(/\.git$/i, "").replace(/\/+$/, "");
    const seg = cleaned.split(/[\/:]/).filter(Boolean).pop();
    if (seg) return seg;
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    })
      .toString()
      .trim();
    if (top) {
      const seg = top.split(/[/\\]/).filter(Boolean).pop();
      if (seg) return seg;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Base branch hint used by the Rising slot. Best-effort: prefers
 * `init.defaultBranch`, else falls back to a well-known default so the
 * fallback is stable rather than nondeterministic.
 */
export function readBaseBranch(env: NodeJS.ProcessEnv = process.env): string | null {
  return readGitConfig("init.defaultBranch", env) ?? null;
}

export interface AstrologyChart {
  sun: ZodiacSign;
  moon: ZodiacSign;
  rising: ZodiacSign;
  /** True when the Sun sign was derived from a real `Date:` header. */
  sunFromDiff: boolean;
  /** True when the Moon sign came from a real `user.birthday` config. */
  moonFromConfig: boolean;
  /** True when the Rising sign consumed real repo/branch context. */
  risingFromConfig: boolean;
}

export interface AstrologyOptions {
  /** Overrides for tests / callers that don't want to shell out. */
  env?: NodeJS.ProcessEnv;
  /**
   * Bypass the git config lookups entirely. Useful in tests and in
   * environments where shelling out to `git` is undesirable.
   */
  noGit?: boolean;
}

function pickSign(id: string): ZodiacSign {
  return BY_ID.get(id) ?? ZODIAC[0];
}

/**
 * Compute the three-sign chart deterministically.
 */
export function computeChart(diff: string, opts: AstrologyOptions = {}): AstrologyChart {
  const env = opts.env ?? process.env;

  // Sun — diff Date header, else hash-synthesized date.
  const parsedDate = parseDiffDate(diff);
  const sunDate = parsedDate ?? syntheticSunDate(diff);
  const sun = pickSign(signFromDate(sunDate));

  // Moon — git config user.birthday, else hash of user.email, else diff hash.
  const birthdayRaw = opts.noGit ? null : readGitConfig("user.birthday", env);
  const birthday = parseBirthday(birthdayRaw);
  let moonDate: Date;
  let moonFromConfig = false;
  if (birthday) {
    moonDate = birthday;
    moonFromConfig = true;
  } else {
    const email = opts.noGit ? null : readGitConfig("user.email", env);
    if (email) {
      moonDate = syntheticDateFromString(email, "moon");
    } else {
      const h = astroHash(diff, "moon").readUInt32BE(0);
      const doy = (h % 365) + 1;
      moonDate = new Date(Date.UTC(2000, 0, 1) + (doy - 1) * 86_400_000);
    }
  }
  const moon = pickSign(signFromDate(moonDate));

  // Rising — base branch + repo name, else diff hash.
  const repo = opts.noGit ? null : readRepoName(env);
  const branch = opts.noGit ? null : readBaseBranch(env);
  let risingDate: Date;
  let risingFromConfig = false;
  if (repo || branch) {
    risingDate = syntheticDateFromString(`${branch ?? "main"}::${repo ?? "-"}`, "rising");
    risingFromConfig = true;
  } else {
    const h = astroHash(diff, "rising").readUInt32BE(0);
    const doy = (h % 365) + 1;
    risingDate = new Date(Date.UTC(2000, 0, 1) + (doy - 1) * 86_400_000);
  }
  const rising = pickSign(signFromDate(risingDate));

  return {
    sun,
    moon,
    rising,
    sunFromDiff: parsedDate !== null,
    moonFromConfig,
    risingFromConfig,
  };
}

export function castAstrology(diff: string, opts: AstrologyOptions = {}): DrawnSymbol[] {
  const chart = computeChart(diff, opts);
  const bySlot: Record<"Sun" | "Moon" | "Rising", ZodiacSign> = {
    Sun: chart.sun,
    Moon: chart.moon,
    Rising: chart.rising,
  };
  const synthesizedNote = !chart.moonFromConfig;
  return SPREAD.map((slotDef) => {
    const sign = bySlot[slotDef.slot];
    return {
      id: `sign:${slotDef.slot.toLowerCase()}:${sign.id}`,
      name: `${sign.glyph} ${sign.name}`,
      position: slotDef.slot,
      meta: {
        glyph: sign.glyph,
        signId: sign.id,
        signName: sign.name,
        element: sign.element,
        modality: sign.modality,
        ruler: sign.ruler,
        keywords: sign.keywords,
        delineation: sign.delineation,
        slotGloss: slotDef.gloss,
        sunFromDiff: chart.sunFromDiff,
        moonFromConfig: chart.moonFromConfig,
        risingFromConfig: chart.risingFromConfig,
        /**
         * Flag on every symbol so downstream renderers can decide to
         * disclose the synthesized natal date once per reading.
         */
        chartSynthesized: synthesizedNote,
      },
    } satisfies DrawnSymbol;
  });
}

function describeSymbol(s: DrawnSymbol): string {
  const meta = s.meta as {
    signName: string;
    element: string;
    modality: string;
    ruler: string;
    keywords: string[];
    delineation: string;
  };
  const kw = meta.keywords.join(", ");
  return [
    `${s.position} — ${meta.signName} (${meta.modality} ${meta.element}, ruled by ${meta.ruler})`,
    `[${kw}] :: ${meta.delineation}`,
  ].join(" ");
}

const CELL_W = 15;

function centerPad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

/**
 * Render the natal chart as three side-by-side house boxes:
 *
 *   +---------------+   +---------------+   +---------------+
 *   |      ♈       |   |      ♌       |   |      ♑       |
 *   |     Aries     |   |      Leo      |   |   Capricorn   |
 *   +---------------+   +---------------+   +---------------+
 *        Sun               Moon              Rising
 *
 * When the chart was cast against a synthesized natal date (no
 * `user.birthday` in git config) a disclosure footer is appended per
 * the acceptance criteria.
 */
export function renderAstrologyAscii(symbols: DrawnSymbol[]): string {
  const boxes = symbols.map((s) => buildBox(s));
  const rows: string[] = [];
  const height = boxes[0]?.length ?? 0;
  for (let r = 0; r < height; r++) {
    rows.push(boxes.map((b) => b[r]).join("   "));
  }
  const labels = symbols
    .map((s) => centerPad(s.position, CELL_W))
    .join("   ");
  const out = [rows.join("\n"), "", labels];

  const anyMeta = symbols[0]?.meta as { chartSynthesized?: boolean } | undefined;
  if (anyMeta?.chartSynthesized) {
    out.push("", "— chart cast from synthesized natal date");
  }
  return out.join("\n");
}

function buildBox(s: DrawnSymbol): string[] {
  const meta = s.meta as { glyph: string; signName: string };
  const top = "+" + "-".repeat(CELL_W - 2) + "+";
  const empty = "|" + " ".repeat(CELL_W - 2) + "|";
  const glyphLine = "|" + centerPad(meta.glyph, CELL_W - 2) + "|";
  const nameLine = "|" + centerPad(meta.signName, CELL_W - 2) + "|";
  return [top, glyphLine, nameLine, top];
}

export const astrology: DivinationMethod = {
  id: "astrology",
  name: "Astrology — Sun / Moon / Rising natal chart of the diff",
  describe() {
    return "casts a three-sign natal chart for the PR: Sun from the diff's creation timestamp, Moon from the author's birthday (or a synthesized fallback), and Rising from the base branch and repo — then reads the aspect between them as the merge prophecy.";
  },
  draw(diff: string) {
    return castAstrology(diff);
  },
  readingPrompt(symbols: DrawnSymbol[], diff: string): ChatMessage[] {
    const symbolStrings = symbols.map(describeSymbol);
    const meta = symbols[0]?.meta as { chartSynthesized?: boolean } | undefined;
    const disclosure = meta?.chartSynthesized
      ? "Note: the natal date was synthesized (no user.birthday in git config); disclose this at the end of the reading in a single '— chart cast from synthesized natal date' line."
      : "";
    const extraSystem = [
      "You are reading a three-sign natal chart cast for a pull request.",
      "Address each of the three signs in order (Sun, Moon, Rising) in 1–2 sentences,",
      "weaving element (fire/earth/air/water), modality (cardinal/fixed/mutable), and ruling planet into a coherent prophecy that respects the actual diff.",
      "Do not invent astronomical aspects beyond the three-sign shorthand.",
      "Close with a single 'Verdict:' line giving a merge prophecy.",
      disclosure,
    ]
      .filter(Boolean)
      .join(" ");
    return assembleReadingPrompt({
      methodName: "astrology",
      symbols: symbolStrings,
      diff,
      extraSystem,
    });
  },
  render(symbols: DrawnSymbol[]) {
    return renderAstrologyAscii(symbols);
  },
};

export default astrology;
