import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import type { DivinationMethod } from "./types.js";

/**
 * Method auto-discovery.
 *
 * At module load we scan this directory for sibling files (excluding the
 * registry, the shared types module, and any private `_*` helpers) and
 * dynamically import each one. Any module that default-exports — or named-
 * exports — an object implementing {@link DivinationMethod} is registered.
 *
 * To add a new method:
 *   1. Drop a file in `src/methods/` (e.g. `numerology.ts`)
 *   2. Export it (default export or a named export object) with a unique `id`
 *   3. Run `npm run build` — the registry picks it up automatically.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(["_registry", "types"]);

function isDivinationMethod(value: unknown): value is DivinationMethod {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.describe === "function" &&
    typeof v.draw === "function" &&
    typeof v.readingPrompt === "function" &&
    typeof v.render === "function"
  );
}

async function discover(): Promise<DivinationMethod[]> {
  const entries = readdirSync(HERE, { withFileTypes: true });
  const found: DivinationMethod[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(m?js|ts)$/.test(entry.name)) continue;
    const base = entry.name.replace(/\.(m?js|ts)$/, "");
    if (SKIP.has(base) || base.startsWith("_")) continue;
    // Skip TS sources when the compiled JS sibling exists (avoid double-load
    // in mixed dirs). In published builds only .js is present.
    if (entry.name.endsWith(".ts") && entries.some((e) => e.name === `${base}.js`)) {
      continue;
    }

    const url = pathToFileURL(resolve(HERE, entry.name)).href;
    let mod: Record<string, unknown>;
    try {
      mod = (await import(url)) as Record<string, unknown>;
    } catch {
      continue;
    }

    for (const exported of Object.values(mod)) {
      if (isDivinationMethod(exported) && !seen.has(exported.id)) {
        seen.add(exported.id);
        found.push(exported);
      }
    }
  }

  // Stable order: alphabetical by id, with the default method floated to the top.
  found.sort((a, b) => {
    if (a.id === DEFAULT_METHOD_ID) return -1;
    if (b.id === DEFAULT_METHOD_ID) return 1;
    return a.id.localeCompare(b.id);
  });
  return found;
}

export const DEFAULT_METHOD_ID = "tarot";

const METHODS: DivinationMethod[] = await discover();
const BY_ID = new Map(METHODS.map((m) => [m.id, m]));

export function listMethods(): ReadonlyArray<DivinationMethod> {
  return METHODS;
}

export function getMethod(id: string): DivinationMethod | undefined {
  return BY_ID.get(id);
}

export type { DivinationMethod, DrawnSymbol } from "./types.js";
