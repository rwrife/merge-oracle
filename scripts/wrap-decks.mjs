#!/usr/bin/env node
// One-shot: wrap existing bundled deck JSON arrays into v1 envelope format.
// Idempotent — skips files already wrapped.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, "../src/data/decks");
const SCHEMA_URL = "https://rwrife.github.io/merge-oracle/deck.schema.json";

const META = {
  "major-arcana": { id: "major-arcana", name: "Major Arcana (Rider-Waite-ish)", method: "tarot" },
  "elder-futhark": { id: "elder-futhark", name: "Elder Futhark", method: "runes" },
  "i-ching":       { id: "i-ching", name: "I Ching (King Wen sequence)", method: "i-ching" },
  "tea-leaves":    { id: "tea-leaves", name: "Tea Leaf Shapes", method: "tea-leaves" },
  "zodiac":        { id: "zodiac", name: "Western Zodiac (12 signs)", method: "astrology" },
};

for (const name of readdirSync(DIR)) {
  if (!name.endsWith(".json")) continue;
  const stem = name.replace(/\.json$/, "");
  const meta = META[stem];
  if (!meta) {
    console.log(`skip: ${name} (no meta)`);
    continue;
  }
  const path = resolve(DIR, name);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    console.log(`skip: ${name} (already wrapped)`);
    continue;
  }
  const wrapped = {
    $schema: SCHEMA_URL,
    id: meta.id,
    name: meta.name,
    method: meta.method,
    version: 1,
    cards: parsed,
  };
  writeFileSync(path, JSON.stringify(wrapped, null, 2) + "\n");
  console.log(`wrapped: ${name} (${parsed.length} cards, method=${meta.method})`);
}
