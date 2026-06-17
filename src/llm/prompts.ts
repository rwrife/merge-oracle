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
