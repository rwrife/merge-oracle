/**
 * `oracle duel` \u2014 comparative reading between two PR/diff contenders.
 *
 * Issue #41. The duel reuses every existing building block (source loaders,
 * divination methods, personas, LLM client) and adds only the *comparative*
 * layer on top:
 *
 *   1. Load both contenders (URL / file / PR-number). Stdin is refused
 *      because a duel needs two named sources.
 *   2. Draw symbols for each side with the same method + persona.
 *   3. Ask the LLM (or offline mock) for a normal reading per contender.
 *   4. Ask the LLM once more, in comparative framing, for a verdict JSON.
 *   5. Render text or JSON.
 *
 * Every step is deterministic when `--offline` is set: same inputs => same
 * verdict, which is important for CI-driven bake-offs and snapshot tests.
 */
import { createHash } from "node:crypto";
import { loadDiff } from "./sources/index.js";
import type { LoadedDiff } from "./sources/types.js";
import type { DivinationMethod, DrawnSymbol, MethodCallOptions } from "./methods/types.js";
import type { Persona } from "./personas/types.js";
import type { LlmClient } from "./llm/index.js";
import { assembleDuelPrompt, assembleReadingPrompt } from "./llm/prompts.js";
import type { ChatMessage } from "./llm/prompts.js";

export type DuelVerdict = "favor-a" | "favor-b" | "favor-neither";
export type DuelConfidence = "low" | "medium" | "high";

export interface DuelVerdictBlob {
  verdict: DuelVerdict;
  confidence: DuelConfidence;
  rationale: string;
  carryForward: string | null;
}

export interface DuelContender {
  label: "A" | "B";
  loaded: LoadedDiff;
  symbols: DrawnSymbol[];
  reading: string;
  stats: { files: number; additions: number; deletions: number };
}

export interface DuelResult {
  method: string;
  persona: string;
  channel: string;
  a: DuelContender;
  b: DuelContender;
  judgement: string;
  verdict: DuelVerdictBlob;
}

export class DuelInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuelInputError";
  }
}

/**
 * Normalize a duel source: allow anything the default source loader can
 * handle EXCEPT stdin. Stdin is ambiguous in a duel (which side is which?).
 */
function assertNotStdin(source: string, label: "A" | "B"): void {
  if (source === "-" || source === "") {
    throw new DuelInputError(
      `duel refuses stdin for contender ${label}: pipe your diff to a file first, or pass a PR URL`,
    );
  }
}

/** Cheap diff-stats parser, just enough for the contender header + prompt. */
export function diffStats(diff: string): { files: number; additions: number; deletions: number } {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  // Fallback: no `diff --git` header (some `git diff` outputs strip it).
  if (files === 0 && (additions > 0 || deletions > 0)) files = 1;
  return { files, additions, deletions };
}

/**
 * Hash a normalized diff so we can detect "same diff twice" duels and
 * refuse them with a wry error \u2014 required by the acceptance criteria.
 */
function fingerprint(diff: string): string {
  return createHash("sha256").update(diff.trim()).digest("hex");
}

/**
 * Parse the verdict JSON out of the LLM's reply. Defensive: the model
 * might wrap it, prefix prose, or omit fields. We locate the last
 * balanced JSON object in the reply and coerce values to the enum.
 */
export function parseDuelReply(reply: string): { judgement: string; verdict: DuelVerdictBlob } {
  const fallback: DuelVerdictBlob = {
    verdict: "favor-neither",
    confidence: "low",
    rationale: "the oracle's reply was unreadable; the duel is a draw by default",
    carryForward: null,
  };
  const trimmed = reply.trim();
  // Locate the last `{ ... }` block. Simple and robust for well-formed
  // one-object tails; if the model got creative, we degrade gracefully.
  const lastOpen = trimmed.lastIndexOf("{");
  const lastClose = trimmed.lastIndexOf("}");
  if (lastOpen === -1 || lastClose === -1 || lastClose < lastOpen) {
    return { judgement: trimmed, verdict: fallback };
  }
  const jsonSlice = trimmed.slice(lastOpen, lastClose + 1);
  const judgement = trimmed.slice(0, lastOpen).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return { judgement: trimmed, verdict: fallback };
  }
  if (!parsed || typeof parsed !== "object") {
    return { judgement, verdict: fallback };
  }
  const p = parsed as Record<string, unknown>;
  const verdictRaw = String(p.verdict ?? "").toLowerCase();
  const verdict: DuelVerdict =
    verdictRaw === "favor-a" || verdictRaw === "favor-b" || verdictRaw === "favor-neither"
      ? verdictRaw
      : "favor-neither";
  const confRaw = String(p.confidence ?? "").toLowerCase();
  const confidence: DuelConfidence =
    confRaw === "low" || confRaw === "medium" || confRaw === "high" ? confRaw : "low";
  const rationale = typeof p.rationale === "string" && p.rationale.trim()
    ? p.rationale.trim()
    : fallback.rationale;
  const carry =
    typeof p.carryForward === "string" && p.carryForward.trim()
      ? p.carryForward.trim()
      : null;
  return {
    judgement: judgement || "(the oracle offered no judgement, only a verdict)",
    verdict: {
      verdict,
      confidence,
      rationale,
      carryForward: verdict === "favor-neither" ? null : carry,
    },
  };
}

export interface RunDuelArgs {
  sourceA: string;
  sourceB: string;
  method: DivinationMethod;
  persona: Persona;
  client: LlmClient;
  methodCallOpts?: MethodCallOptions;
  /** Injectable diff loader; defaults to production `loadDiff`. Used in tests. */
  load?: (locator: string) => Promise<LoadedDiff>;
}

/**
 * Run the full duel pipeline. Pure orchestration \u2014 no CLI, no side effects
 * other than the caller-supplied `load` and `client`.
 */
export async function runDuel(args: RunDuelArgs): Promise<DuelResult> {
  const { sourceA, sourceB, method, persona, client } = args;
  assertNotStdin(sourceA, "A");
  assertNotStdin(sourceB, "B");
  const load = args.load ?? loadDiff;

  const [loadedA, loadedB] = await Promise.all([load(sourceA), load(sourceB)]);

  if (fingerprint(loadedA.diff) === fingerprint(loadedB.diff)) {
    throw new DuelInputError(
      "the oracle refuses to duel a contender against its own reflection \u2014 both diffs are identical",
    );
  }

  const runSide = async (label: "A" | "B", loaded: LoadedDiff): Promise<DuelContender> => {
    const symbols = method.draw(loaded.diff, args.methodCallOpts);
    let messages = method.readingPrompt(symbols, loaded.diff, args.methodCallOpts);
    if (persona.systemPrompt.trim()) {
      messages = [
        ...messages,
        { role: "system", content: `Persona \u2014 ${persona.name}: ${persona.systemPrompt}` },
      ];
    }
    const reading = await client.complete(messages);
    return { label, loaded, symbols, reading, stats: diffStats(loaded.diff) };
  };

  // Run per-side readings sequentially so offline snapshots stay deterministic
  // regardless of scheduler ordering.
  const a = await runSide("A", loadedA);
  const b = await runSide("B", loadedB);

  const duelMessages: ChatMessage[] = assembleDuelPrompt({
    methodName: method.name,
    a: { label: "A", origin: a.loaded.origin, reading: a.reading, stats: a.stats },
    b: { label: "B", origin: b.loaded.origin, reading: b.reading, stats: b.stats },
    extraSystem: persona.systemPrompt.trim()
      ? `Persona \u2014 ${persona.name}: ${persona.systemPrompt}`
      : undefined,
  });
  const reply = await client.complete(duelMessages);
  const { judgement, verdict } = parseDuelReply(reply);

  return {
    method: method.id,
    persona: persona.id,
    channel: client.id,
    a,
    b,
    judgement,
    verdict,
  };
}

/**
 * Deterministic offline judgement generator. The stock offline client returns
 * canned prose that won't contain a verdict JSON \u2014 so when we detect the
 * offline channel we synthesize a verdict from the two contenders' stats.
 *
 * Rule: favor the side with more meaningful signal (net LoC + files), fall
 * back to favor-neither on a tie. Confidence scales with the gap.
 *
 * Exported so tests and CI bake-offs can reuse the same rule.
 */
export function synthesizeOfflineVerdict(a: DuelContender, b: DuelContender): {
  judgement: string;
  verdict: DuelVerdictBlob;
} {
  const score = (c: DuelContender) =>
    c.stats.additions + c.stats.deletions + c.stats.files * 5;
  const sa = score(a);
  const sb = score(b);
  const gap = Math.abs(sa - sb);
  const total = Math.max(sa + sb, 1);
  const ratio = gap / total;
  const confidence: DuelConfidence = ratio > 0.5 ? "high" : ratio > 0.2 ? "medium" : "low";
  if (sa === sb) {
    return {
      judgement: "the offline oracle finds both contenders equally weighted; the cards decline to choose.",
      verdict: {
        verdict: "favor-neither",
        confidence: "low",
        rationale: "identical scoring in offline mode",
        carryForward: null,
      },
    };
  }
  const winner: "A" | "B" = sa > sb ? "A" : "B";
  const loser: DuelContender = winner === "A" ? b : a;
  return {
    judgement: `offline reading favors contender ${winner}: greater signal in files and lines touched.`,
    verdict: {
      verdict: winner === "A" ? "favor-a" : "favor-b",
      confidence,
      rationale: `contender ${winner} carries the heavier omen weight (${winner === "A" ? sa : sb} vs ${winner === "A" ? sb : sa})`,
      carryForward: `borrow one restraint from contender ${loser.label}: it touched fewer surfaces`,
    },
  };
}

/**
 * Convenience wrapper: run duel, then if the LLM channel is the offline
 * mock and the parsed verdict is the fallback (favor-neither / low), swap
 * in the deterministic synthesized verdict so `--offline` runs remain
 * useful for demos and tests.
 */
export async function runDuelWithOfflineFallback(args: RunDuelArgs): Promise<DuelResult> {
  const result = await runDuel(args);
  const isOffline = result.channel.startsWith("offline:");
  const looksLikeFallback =
    result.verdict.verdict === "favor-neither" &&
    result.verdict.confidence === "low" &&
    result.verdict.rationale.includes("unreadable");
  if (isOffline && looksLikeFallback) {
    const synth = synthesizeOfflineVerdict(result.a, result.b);
    return { ...result, judgement: synth.judgement, verdict: synth.verdict };
  }
  return result;
}

/** Structured JSON payload for `--json` output. */
export function duelJsonBlob(result: DuelResult): Record<string, unknown> {
  const contender = (c: DuelContender) => ({
    label: c.label,
    source: c.loaded.source,
    origin: c.loaded.origin,
    stats: c.stats,
    symbols: c.symbols,
    reading: c.reading,
  });
  return {
    method: result.method,
    persona: result.persona,
    channel: result.channel,
    duel: {
      a: contender(result.a),
      b: contender(result.b),
      verdict: result.verdict.verdict,
      confidence: result.verdict.confidence,
      rationale: result.verdict.rationale,
      carryForward: result.verdict.carryForward,
      judgement: result.judgement,
    },
  };
}

/**
 * Compact per-contender renderer used inside the duel text output. Kept
 * separate from `oracle read`'s full renderer to stay short (one contender
 * shouldn't dominate the duel card).
 */
export function renderCompactContender(c: DuelContender): string {
  const symbolLine = c.symbols.length === 0
    ? "(no symbols drawn)"
    : c.symbols
        .map((s) => `${s.position}: ${s.name}${s.reversed ? " \u26A1" : ""}`)
        .join(" | ");
  // Only show the first paragraph of the reading; the duel narrative below
  // handles the comparative flourishes.
  const firstPara = c.reading.split(/\n{2,}/)[0].trim();
  const shortReading = firstPara.length > 320 ? firstPara.slice(0, 317) + "..." : firstPara;
  return [
    `\ud83c\udccf Reading ${c.label} \u2014 ${c.loaded.origin}`,
    `   stats: files=${c.stats.files}, +${c.stats.additions}/-${c.stats.deletions}`,
    `   ${symbolLine}`,
    ``,
    shortReading,
  ].join("\n");
}

const VERDICT_EMOJI: Record<DuelVerdict, string> = {
  "favor-a": "\ud83c\udfc6",
  "favor-b": "\ud83c\udfc6",
  "favor-neither": "\ud83e\udd1d",
};

export function renderDuelCard(result: DuelResult): string {
  const winnerLabel =
    result.verdict.verdict === "favor-a"
      ? "Contender A"
      : result.verdict.verdict === "favor-b"
        ? "Contender B"
        : "Neither \u2014 the duel is a draw";
  const carryLine = result.verdict.carryForward
    ? `\ud83d\udd6f\ufe0f Carry-forward: ${result.verdict.carryForward}`
    : "\ud83d\udd6f\ufe0f Carry-forward: (none \u2014 both sides stand on their own)";
  return [
    `\u2694\ufe0f The contenders`,
    `   A: ${result.a.loaded.origin} (files=${result.a.stats.files}, +${result.a.stats.additions}/-${result.a.stats.deletions})`,
    `   B: ${result.b.loaded.origin} (files=${result.b.stats.files}, +${result.b.stats.additions}/-${result.b.stats.deletions})`,
    `   method: ${result.method}   persona: ${result.persona}   channel: ${result.channel}`,
    ``,
    renderCompactContender(result.a),
    ``,
    renderCompactContender(result.b),
    ``,
    `\u2696\ufe0f The judgement`,
    result.judgement,
    ``,
    `${VERDICT_EMOJI[result.verdict.verdict]} Verdict: ${winnerLabel} (confidence: ${result.verdict.confidence})`,
    `   ${result.verdict.rationale}`,
    carryLine,
    ``,
  ].join("\n");
}
