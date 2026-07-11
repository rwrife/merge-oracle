/**
 * Reusable prompt fragments for the oracle's divination rituals.
 *
 * Keep these short and composable: a divination method assembles a final
 * message list by combining one or more system fragments with its own
 * method-specific user prompt.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Core persona — the oracle voice. */
export const ORACLE_PERSONA = [
  "You are merge-oracle, a theatrical AI diviner of pull requests.",
  "Speak in short, ritual cadence. Use mystical language but stay specific to the diff.",
  "Never invent files, functions, or symbols that do not appear in the provided diff.",
].join(" ");

/** Output discipline — keeps readings consumable in a terminal. */
export const OUTPUT_DISCIPLINE = [
  "Respond in plain text suitable for a terminal (no markdown headers, no code fences).",
  "Use at most ~200 words unless the method explicitly asks for more.",
].join(" ");

/** Safety + honesty rail — discourages hallucinated security claims. */
export const HONESTY_RAIL = [
  "If the diff is empty or unreadable, say so plainly instead of inventing prophecy.",
  "Phrase guesses as omens (\"the cards suggest…\"), never as certainties.",
].join(" ");

/** Standard system block used by most methods. */
export function systemPreamble(extra?: string): ChatMessage {
  const parts = [ORACLE_PERSONA, OUTPUT_DISCIPLINE, HONESTY_RAIL];
  if (extra && extra.trim()) parts.push(extra.trim());
  return { role: "system", content: parts.join("\n\n") };
}

/** Assemble a standard reading prompt: system + user. */
export function assembleReadingPrompt(args: {
  methodName: string;
  symbols: string[];
  diff: string;
  extraSystem?: string;
  maxDiffChars?: number;
}): ChatMessage[] {
  const { methodName, symbols, diff } = args;
  const maxDiffChars = args.maxDiffChars ?? 8000;
  const truncatedDiff =
    diff.length > maxDiffChars
      ? diff.slice(0, maxDiffChars) + `\n…[diff truncated, ${diff.length - maxDiffChars} bytes omitted]`
      : diff;

  const symbolBlock =
    symbols.length === 0
      ? "(no symbols drawn)"
      : symbols.map((s, i) => `${i + 1}. ${s}`).join("\n");

  const user = [
    `Divination method: ${methodName}.`,
    `Symbols drawn:\n${symbolBlock}`,
    "",
    "Diff under examination:",
    "```diff",
    truncatedDiff,
    "```",
    "",
    "Deliver the reading.",
  ].join("\n");

  return [systemPreamble(args.extraSystem), { role: "user", content: user }];
}

/**
 * Duel framing (issue #41): two contenders, one verdict.
 *
 * The duel prompt receives two already-rendered per-contender readings
 * (compact form) plus lightweight stat summaries — it never re-reads the
 * raw diffs itself, which keeps the comparative judgement grounded in the
 * previously-drawn symbols rather than tempting the model to invent new
 * findings across both sides.
 *
 * The response contract is a single JSON object matching {@link DuelVerdictSchema}.
 * Callers parse defensively; a malformed reply falls back to `favor-neither`.
 */
export interface DuelContenderSketch {
  label: "A" | "B";
  origin: string;
  reading: string;
  stats: { files: number; additions: number; deletions: number };
}

export function assembleDuelPrompt(args: {
  a: DuelContenderSketch;
  b: DuelContenderSketch;
  methodName: string;
  extraSystem?: string;
}): ChatMessage[] {
  const { a, b, methodName } = args;
  const block = (c: DuelContenderSketch) =>
    [
      `Contender ${c.label} — ${c.origin}`,
      `stats: files=${c.stats.files}, +${c.stats.additions}/-${c.stats.deletions}`,
      `reading:`,
      c.reading,
    ].join("\n");

  const user = [
    `Divination method: ${methodName}. You are judging a DUEL between two contenders that solve the same problem.`,
    "",
    block(a),
    "",
    block(b),
    "",
    "Compose two things, in order:",
    "1. A short comparative narrative (2-3 sentences) — the judgement — as plain prose. Do not repeat the contender readings verbatim.",
    "2. A single JSON object on its own final line, no code fence, matching exactly:",
    '   {"verdict":"favor-a"|"favor-b"|"favor-neither","confidence":"low"|"medium"|"high","rationale":"one line","carryForward":"one bullet from the loser worth adopting (omit if favor-neither)"}',
    "Pick favor-neither only when the readings are genuinely a draw. Keep total output under ~180 words.",
  ].join("\n");

  return [systemPreamble(args.extraSystem), { role: "user", content: user }];
}

/**
 * Chronicle framing (issue #40): a *meta-reading* across many past PRs.
 * The chronicle prompt intentionally does NOT include any single diff —
 * it reasons only over the aggregated symbol/reviewer signals so the
 * model stays honest about what it actually has.
 */
export interface ChronicleAggregateSketch {
  readings: number;
  dominantMethod: string | null;
  dominantPersona: string | null;
  methodTallies: Array<{ methodId: string; count: number }>;
  outcomeTallies: Record<string, number>;
  omens: Array<{ id: string; name: string | null; count: number; frequency: number; methods: string[] }>;
  weather: {
    moodLabel: string;
    totalReviews: number;
    approvals: number;
    changesRequested: number;
    commented: number;
  } | null;
  repos: string[];
  selection: {
    strategy: string;
    count: number;
    dateRange: { earliest: string | null; latest: string | null };
  };
}

export function assembleChroniclePrompt(args: {
  aggregate: ChronicleAggregateSketch;
  extraSystem?: string;
}): ChatMessage[] {
  const { aggregate } = args;
  const omenLines = aggregate.omens.length > 0
    ? aggregate.omens.map((o, i) => {
        const label = o.name ? `${o.name} (${o.id})` : o.id;
        return `${i + 1}. ${label} — ${o.count}× (${Math.round(o.frequency * 100)}%), via ${o.methods.join("/") || "?"}`;
      }).join("\n")
    : "(no recurring omens: every symbol was singular)";
  const outcomeLine = Object.entries(aggregate.outcomeTallies)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "(no outcomes recorded)";
  const weatherLine = aggregate.weather
    ? `${aggregate.weather.moodLabel} (approvals=${aggregate.weather.approvals}, changes-requested=${aggregate.weather.changesRequested}, commented=${aggregate.weather.commented})`
    : "(no reviewer weather available for this cohort)";
  const rangeLabel = aggregate.selection.dateRange.earliest
    ? `${aggregate.selection.dateRange.earliest} → ${aggregate.selection.dateRange.latest}`
    : "(no dates)";
  const scope = aggregate.repos.length === 0
    ? "(no GitHub repo attributed)"
    : aggregate.repos.join(", ");

  const user = [
    "You are composing a CHRONICLE — a meta-reading across a batch of past PR readings.",
    "You have no diffs, only aggregated signals. Do NOT invent specific commits or files.",
    "",
    `Selection: strategy=${aggregate.selection.strategy}, readings=${aggregate.selection.count}, range=${rangeLabel}.`,
    `Scope: ${scope}.`,
    `Dominant method: ${aggregate.dominantMethod ?? "(none)"}. Dominant persona: ${aggregate.dominantPersona ?? "(none)"}.`,
    `Outcome tallies: ${outcomeLine}.`,
    `Team weather: ${weatherLine}.`,
    "",
    "Recurring omens (already ranked by frequency):",
    omenLines,
    "",
    "Compose the reading in exactly these five sections, each introduced by its glyph on its own line:",
    "⚱️ The gathering — one line summarizing the cohort.",
    "🕯️ Recurring omens — one line per omen (up to three), each interpreting *what its repetition suggests*.",
    "🌗 The team's weather — one line, or omit gracefully if no weather is available.",
    "📜 The chronicle — two to four short paragraphs of narrative arc.",
    "🔮 The prophecy — a single sentence forecast for the next release cycle.",
    "Keep the whole reading under ~350 words. No markdown headers, no code fences.",
  ].join("\n");

  return [systemPreamble(args.extraSystem), { role: "user", content: user }];
}
