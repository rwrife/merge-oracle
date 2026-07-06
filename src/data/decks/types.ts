/**
 * Deck primitives shared by the registry and every method that supports
 * pluggable decks. A deck is nothing more than a small, immutable JSON
 * document that a method knows how to draw symbols from.
 *
 * Per-method card shapes live inside each method (tarot, runes, ...). The
 * registry only cares about the outer envelope: `id`, `name`, `method`,
 * `version`, and `cards[]`. Each method contributes a {@link DeckSchema}
 * that validates a single card entry.
 */

/**
 * Provenance of a deck — where the registry loaded it from.
 *
 *  - `bundled`: shipped inside `src/data/decks/` and always available.
 *  - `env`:     picked up from a `MERGE_ORACLE_DECKS_DIR` directory.
 *  - `arg`:     loaded ad-hoc from a `--deck=<path>` CLI argument.
 */
export type DeckSource = "bundled" | "env" | "arg";

/**
 * Serialized form of a deck as it lives on disk.
 *
 * The registry does not attempt to be a general-purpose schema validator.
 * Only the required envelope fields (`id`, `name`, `method`, `version`,
 * `cards`) are enforced up front. Card contents are handed to the
 * method-specific {@link DeckSchema} for finer-grained validation.
 *
 * The `$schema` field is preserved when present so decks stay round-trippable
 * through the loader, but the registry itself does not resolve or fetch it.
 */
export interface DeckDocument<TCard = Record<string, unknown>> {
  $schema?: string;
  id: string;
  name: string;
  method: string;
  version: number;
  cards: ReadonlyArray<TCard>;
}

/**
 * A fully-resolved deck as returned by the registry. Adds provenance and
 * (when applicable) the absolute path the deck was loaded from so callers
 * can print helpful diagnostics.
 */
export interface LoadedDeck<TCard = Record<string, unknown>> extends DeckDocument<TCard> {
  source: DeckSource;
  sourcePath: string | null;
}

/**
 * Per-method deck validator. Each method (tarot, runes, ...) exports one of
 * these so it can enforce its own card shape while sharing the outer
 * registry envelope with everyone else.
 *
 * The `validateCard` callback receives a single raw card and its zero-based
 * index in the deck. On success it returns the (optionally normalized) card;
 * on failure it must throw an {@link Error} whose message reads sensibly on
 * its own — the registry wraps it with the deck id and card index.
 */
export interface DeckSchema<TCard> {
  /** The method id this schema applies to (e.g. `"tarot"`, `"runes"`). */
  readonly method: string;
  /**
   * Validate a single raw card. Unknown fields should be silently ignored;
   * missing required fields must throw a `readable message`.
   */
  validateCard(raw: unknown, index: number): TCard;
}

/**
 * Failure raised when a deck document does not satisfy the registry envelope
 * or the per-method card schema. Carries the deck id (when known) and, for
 * card-level failures, the offending card index so callers can point users
 * straight at the problem.
 */
export class DeckValidationError extends Error {
  readonly deckId: string | null;
  readonly cardIndex: number | null;
  constructor(message: string, opts: { deckId?: string | null; cardIndex?: number | null } = {}) {
    super(message);
    this.name = "DeckValidationError";
    this.deckId = opts.deckId ?? null;
    this.cardIndex = opts.cardIndex ?? null;
  }
}
