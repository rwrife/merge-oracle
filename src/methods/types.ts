import type { ChatMessage } from "../llm/prompts.js";

/**
 * A divination method is a small plugin that:
 *  1. draws a set of symbols deterministically from a diff,
 *  2. assembles a reading prompt from those symbols + the diff,
 *  3. renders the drawn symbols for terminal display.
 */
export interface DivinationMethod {
  readonly id: string;
  readonly name: string;
  describe(): string;
  draw(diff: string): DrawnSymbol[];
  readingPrompt(symbols: DrawnSymbol[], diff: string): ChatMessage[];
  render(symbols: DrawnSymbol[]): string;
}

export interface DrawnSymbol {
  /** Stable id of the drawn symbol within its deck (e.g. tarot card id). */
  id: string;
  /** Human-readable label (e.g. "The Fool"). */
  name: string;
  /** Slot the symbol occupies in the spread (e.g. "Past"). */
  position: string;
  /** True when the symbol is interpreted in its inverted form. */
  reversed?: boolean;
  /** Free-form metadata the method may attach (keywords, meanings, etc.). */
  meta?: Record<string, unknown>;
}
