import type { ChatMessage } from "../llm/prompts.js";

/**
 * Optional spread descriptor a method can declare in {@link DivinationMethod.supportedSpreads}.
 * The `id` is what callers pass as `--spread=<id>`.
 */
export interface SpreadDescriptor {
  readonly id: string;
  readonly name: string;
  readonly cards: number;
  readonly default?: boolean;
}

/**
 * Options threaded through draw/readingPrompt/render so a method can honor
 * the caller's choice of spread (or fall back to its default).
 */
export interface MethodCallOptions {
  spread?: string;
}

/**
 * A divination method is a small plugin that:
 *  1. draws a set of symbols deterministically from a diff,
 *  2. assembles a reading prompt from those symbols + the diff,
 *  3. renders the drawn symbols for terminal display.
 *
 * Methods MAY declare {@link supportedSpreads} when they offer more than
 * a single fixed spread (e.g. tarot's three-card vs. celtic-cross).
 */
export interface DivinationMethod {
  readonly id: string;
  readonly name: string;
  describe(): string;
  readonly supportedSpreads?: ReadonlyArray<SpreadDescriptor>;
  draw(diff: string, opts?: MethodCallOptions): DrawnSymbol[];
  readingPrompt(symbols: DrawnSymbol[], diff: string, opts?: MethodCallOptions): ChatMessage[];
  render(symbols: DrawnSymbol[], opts?: MethodCallOptions): string;
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
