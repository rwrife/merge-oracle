import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import type { Persona } from "./types.js";

/**
 * Persona auto-discovery (mirrors `methods/_registry.ts`).
 *
 * Drops a file in `src/personas/`, export it (default or named) as a value
 * implementing {@link Persona}, and the registry picks it up at module load.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(["_registry", "types"]);

function isPersona(value: unknown): value is Persona {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.describe === "function" &&
    typeof v.systemPrompt === "string" &&
    typeof v.offlineLines === "function"
  );
}

async function discover(): Promise<Persona[]> {
  const entries = readdirSync(HERE, { withFileTypes: true });
  const found: Persona[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(m?js|ts)$/.test(entry.name)) continue;
    const base = entry.name.replace(/\.(m?js|ts)$/, "");
    if (SKIP.has(base) || base.startsWith("_")) continue;
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
      if (isPersona(exported) && !seen.has(exported.id)) {
        seen.add(exported.id);
        found.push(exported);
      }
    }
  }

  found.sort((a, b) => {
    if (a.id === DEFAULT_PERSONA_ID) return -1;
    if (b.id === DEFAULT_PERSONA_ID) return 1;
    return a.id.localeCompare(b.id);
  });
  return found;
}

export const DEFAULT_PERSONA_ID = "default";

const PERSONAS: Persona[] = await discover();
const BY_ID = new Map(PERSONAS.map((p) => [p.id, p]));

export function listPersonas(): ReadonlyArray<Persona> {
  return PERSONAS;
}

export function getPersona(id: string): Persona | undefined {
  return BY_ID.get(id);
}

/**
 * Resolve the persona for a given run.
 *  - explicit `id` wins (caller must validate; returns undefined if unknown)
 *  - else `ORACLE_PERSONA` env var, if set and known
 *  - else the default persona
 */
export function resolvePersona(
  id: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Persona | undefined {
  if (id) return getPersona(id);
  const envId = env.ORACLE_PERSONA;
  if (envId) {
    const p = getPersona(envId);
    if (p) return p;
  }
  return getPersona(DEFAULT_PERSONA_ID);
}

export type { Persona } from "./types.js";
