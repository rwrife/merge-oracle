import type { DrawnSymbol } from "../methods/types.js";

/**
 * A persona swaps the *voice* the oracle uses, without touching the
 * divination *method* (the symbols drawn). Methods stay the same; only the
 * narrator changes.
 *
 *  - `systemPrompt` is appended after the method's `extraSystem` block and
 *    instructs the LLM how to speak.
 *  - `offlineLines` is consulted by the offline mock to ensure that even
 *    without an LLM the chosen persona produces distinctive output.
 */
export interface Persona {
  readonly id: string;
  readonly name: string;
  describe(): string;
  readonly systemPrompt: string;
  offlineLines(symbols: DrawnSymbol[]): string[];
}
