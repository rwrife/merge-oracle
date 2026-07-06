/**
 * Deck registry — discovery and loading of deck JSON documents.
 *
 * The registry is intentionally simple: it walks a fixed set of directories
 * (bundled + optional env-configured) and returns loaded {@link LoadedDeck}
 * documents keyed by id. Per-method card validation happens inside each
 * method (see `src/methods/tarot.ts`, `src/methods/runes.ts`, ...).
 *
 * Discovery sources, in precedence order (later ones override earlier ones
 * when ids collide, EXCEPT bundled decks which are always immutable):
 *
 *   1. `src/data/decks/`               → bundled decks (`source: "bundled"`)
 *   2. `$MERGE_ORACLE_DECKS_DIR/*.json` → optional user decks (`source: "env"`)
 *   3. an explicit `--deck=<path>`      → loaded ad-hoc on demand (`source: "arg"`)
 *
 * The registry rejects env-provided decks whose id collides with a bundled
 * deck (helpful error, no silent override). Env decks may collide with each
 * other only when the file paths are identical.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeckValidationError,
  type DeckDocument,
  type DeckSource,
  type LoadedDeck,
} from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = HERE; // src/data/decks/

/** File names in {@link BUNDLED_DIR} that are NOT decks. */
const NON_DECK_FILES = new Set(["_registry.ts", "_registry.js", "types.ts", "types.js"]);

/** Env var that points at a directory of extra deck JSON files. */
export const DECKS_DIR_ENV = "MERGE_ORACLE_DECKS_DIR";

interface DeckSourceEntry {
  dir: string;
  source: Exclude<DeckSource, "arg">;
}

function collectSourceDirs(): DeckSourceEntry[] {
  const dirs: DeckSourceEntry[] = [{ dir: BUNDLED_DIR, source: "bundled" }];
  const envDir = process.env[DECKS_DIR_ENV];
  if (envDir && envDir.trim().length > 0) {
    const resolved = isAbsolute(envDir) ? envDir : resolve(process.cwd(), envDir);
    try {
      if (statSync(resolved).isDirectory()) {
        dirs.push({ dir: resolved, source: "env" });
      }
    } catch {
      // Non-existent env dir is not fatal — it just means no user decks.
    }
  }
  return dirs;
}

/**
 * Parse and envelope-validate a deck JSON document. Card contents are not
 * inspected here; that is a per-method concern.
 */
export function parseDeckJson(raw: string, sourcePath: string | null): DeckDocument {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new DeckValidationError(
      `deck JSON is not valid${sourcePath ? ` (${sourcePath})` : ""}: ${(err as Error).message}`,
    );
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new DeckValidationError(
      `deck must be a JSON object${sourcePath ? ` (${sourcePath})` : ""}`,
    );
  }
  const obj = json as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  const name = typeof obj.name === "string" ? obj.name : null;
  const method = typeof obj.method === "string" ? obj.method : null;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : null;
  const cards = Array.isArray(obj.cards) ? obj.cards : null;

  const missing: string[] = [];
  if (!id) missing.push("id");
  if (!name) missing.push("name");
  if (!method) missing.push("method");
  if (version === null) missing.push("version");
  if (!cards) missing.push("cards[]");
  if (missing.length > 0) {
    throw new DeckValidationError(
      `deck ${sourcePath ? `(${sourcePath}) ` : ""}is missing required field(s): ${missing.join(", ")}`,
      { deckId: id },
    );
  }
  // Deck ids drive registry lookup — enforce a sane, url-friendly shape so
  // typos don't turn into subtle "id not found" mysteries.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id!)) {
    throw new DeckValidationError(
      `deck id must be alphanumeric with . _ -, got '${id}'`,
      { deckId: id },
    );
  }
  if (cards!.length === 0) {
    throw new DeckValidationError(`deck '${id}' has no cards`, { deckId: id });
  }
  return {
    $schema: typeof obj.$schema === "string" ? obj.$schema : undefined,
    id: id!,
    name: name!,
    method: method!,
    version: version!,
    cards: cards!,
  };
}

function loadDeckFile(path: string, source: DeckSource): LoadedDeck {
  const raw = readFileSync(path, "utf8");
  const doc = parseDeckJson(raw, path);
  return { ...doc, source, sourcePath: path };
}

/**
 * Load a deck from an explicit file path. Used by `--deck=./my-deck.json`.
 * The returned deck's source is always `"arg"` regardless of where the file
 * happens to live on disk.
 */
export function loadDeckFromPath(path: string): LoadedDeck {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  try {
    statSync(abs);
  } catch {
    throw new DeckValidationError(`deck file not found: ${abs}`);
  }
  return loadDeckFile(abs, "arg");
}

let CACHE: LoadedDeck[] | null = null;
let CACHE_BY_ID: Map<string, LoadedDeck> | null = null;

function scan(): { decks: LoadedDeck[]; byId: Map<string, LoadedDeck> } {
  const decks: LoadedDeck[] = [];
  const byId = new Map<string, LoadedDeck>();
  const dirs = collectSourceDirs();

  for (const { dir, source } of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (source === "bundled" && NON_DECK_FILES.has(name)) continue;
      if (extname(name).toLowerCase() !== ".json") continue;
      const path = resolve(dir, name);
      let deck: LoadedDeck;
      try {
        deck = loadDeckFile(path, source);
      } catch (err) {
        // A malformed deck should not take down the whole registry — surface
        // a warning and skip. The CLI can offer a strict mode later.
        process.stderr.write(
          `⚠ deck ignored (${path}): ${(err as Error).message}\n`,
        );
        continue;
      }
      if (byId.has(deck.id)) {
        const prior = byId.get(deck.id)!;
        // Bundled decks are always immutable — env decks cannot override them.
        if (prior.source === "bundled" && deck.source !== "bundled") {
          process.stderr.write(
            `⚠ deck ignored (${path}): id '${deck.id}' collides with bundled deck; ` +
              `rename the file to override differently.\n`,
          );
          continue;
        }
        // Two env decks with the same id → also skip the later one loudly.
        process.stderr.write(
          `⚠ deck ignored (${path}): id '${deck.id}' already loaded from ${prior.sourcePath}\n`,
        );
        continue;
      }
      byId.set(deck.id, deck);
      decks.push(deck);
    }
  }

  // Stable order: bundled first (alpha by id), then env (alpha by id).
  decks.sort((a, b) => {
    if (a.source !== b.source) return a.source === "bundled" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return { decks, byId };
}

function ensureLoaded(): { decks: LoadedDeck[]; byId: Map<string, LoadedDeck> } {
  if (CACHE && CACHE_BY_ID) return { decks: CACHE, byId: CACHE_BY_ID };
  const { decks, byId } = scan();
  CACHE = decks;
  CACHE_BY_ID = byId;
  return { decks, byId };
}

/**
 * Reset the internal cache. Exposed for tests that mutate the environment
 * (e.g. setting {@link DECKS_DIR_ENV}) between assertions.
 */
export function resetDeckRegistry(): void {
  CACHE = null;
  CACHE_BY_ID = null;
}

/** All registered decks, optionally filtered by method id. */
export function listDecks(methodId?: string): ReadonlyArray<LoadedDeck> {
  const { decks } = ensureLoaded();
  if (!methodId) return decks;
  return decks.filter((d) => d.method === methodId);
}

/** Look up a registered deck by id. Returns undefined for unknown ids. */
export function getDeckById(id: string): LoadedDeck | undefined {
  const { byId } = ensureLoaded();
  return byId.get(id);
}

/**
 * Resolve a `--deck=<value>` argument:
 *   - If `value` resolves to a file on disk, load it ad-hoc (source `"arg"`).
 *   - Otherwise look it up in the registry by id.
 *
 * When `methodId` is provided, the resolved deck's `method` must match.
 * A helpful {@link DeckValidationError} is thrown on mismatch or not-found.
 */
export function resolveDeck(value: string, methodId?: string): LoadedDeck {
  let deck: LoadedDeck | undefined;
  // Filesystem path wins if it resolves to a file. This intentionally covers
  // relative paths ('./foo.json') as well as bare ids that happen to be
  // filenames in the cwd.
  const asPath = isAbsolute(value) ? value : resolve(process.cwd(), value);
  let looksLikeFile = false;
  try {
    looksLikeFile = statSync(asPath).isFile();
  } catch {
    /* not a file */
  }
  if (looksLikeFile) {
    deck = loadDeckFromPath(value);
  } else {
    deck = getDeckById(value);
  }
  if (!deck) {
    throw new DeckValidationError(
      `no deck found for '${value}' (looked up in the registry and as a file path)`,
    );
  }
  if (methodId && deck.method !== methodId) {
    throw new DeckValidationError(
      `deck '${deck.id}' is for method '${deck.method}', not '${methodId}'`,
      { deckId: deck.id },
    );
  }
  return deck;
}

/**
 * Convenience for tests / callers that already have a raw deck object in
 * memory and just want the envelope validated. Not exported through the
 * package barrel — internal use.
 */
export function loadDeckFromMemory(doc: unknown, source: DeckSource = "arg"): LoadedDeck {
  const parsed = parseDeckJson(JSON.stringify(doc), null);
  return { ...parsed, source, sourcePath: null };
}

/** Cheap presentation helper used by `oracle decks`. */
export function describeDeckSource(deck: LoadedDeck): string {
  switch (deck.source) {
    case "bundled":
      return "bundled";
    case "env":
      return `env:${deck.sourcePath ? basename(dirname(deck.sourcePath)) : DECKS_DIR_ENV}`;
    case "arg":
      return `arg:${deck.sourcePath ?? "(inline)"}`;
  }
}
