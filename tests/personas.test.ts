import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_PERSONA_ID,
  getPersona,
  listPersonas,
  resolvePersona,
} from "../src/personas/_registry.js";
import { tarot } from "../src/methods/tarot.js";
import { createOfflineClient } from "../src/llm/client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../dist/cli.js");

const FIXTURE = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " export function foo() {",
  "-  return 1;",
  "+  return 2;",
  "+  // changed",
  " }",
].join("\n");

describe("persona registry", () => {
  it("ships at least three non-default personas", () => {
    const ids = listPersonas().map((p) => p.id);
    expect(ids).toContain(DEFAULT_PERSONA_ID);
    const others = ids.filter((id) => id !== DEFAULT_PERSONA_ID);
    expect(others.length).toBeGreaterThanOrEqual(3);
  });

  it("floats the default persona to the top of the list", () => {
    expect(listPersonas()[0].id).toBe(DEFAULT_PERSONA_ID);
  });

  it("returns undefined for unknown ids", () => {
    expect(getPersona("not-a-real-persona")).toBeUndefined();
  });

  it("resolvePersona honours ORACLE_PERSONA env when no flag is given", () => {
    const env = { ORACLE_PERSONA: "crone" } as NodeJS.ProcessEnv;
    expect(resolvePersona(undefined, env)?.id).toBe("crone");
  });

  it("resolvePersona ignores env when an explicit (valid) id is passed", () => {
    const env = { ORACLE_PERSONA: "crone" } as NodeJS.ProcessEnv;
    expect(resolvePersona("bard", env)?.id).toBe("bard");
  });

  it("resolvePersona falls back to default when env is unset", () => {
    expect(resolvePersona(undefined, {} as NodeJS.ProcessEnv)?.id).toBe(
      DEFAULT_PERSONA_ID,
    );
  });
});

describe("persona offline output", () => {
  it("produces distinct lines per persona for the same diff", async () => {
    const symbols = tarot.draw(FIXTURE);
    const personas = listPersonas();
    const readings = new Map<string, string>();
    for (const p of personas) {
      const client = createOfflineClient(p.offlineLines(symbols));
      const reading = await client.complete([
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ]);
      readings.set(p.id, reading);
    }
    // every persona's reading must be unique
    const unique = new Set(readings.values());
    expect(unique.size).toBe(personas.length);
  });
});

describe("oracle personas CLI", () => {
  it("lists personas as JSON with default flagged", () => {
    const res = spawnSync(process.execPath, [CLI, "personas", "--json"], {
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.default).toBe(DEFAULT_PERSONA_ID);
    expect(Array.isArray(parsed.personas)).toBe(true);
    expect(parsed.personas.length).toBeGreaterThanOrEqual(4);
    const def = parsed.personas.find((p: { id: string }) => p.id === DEFAULT_PERSONA_ID);
    expect(def).toBeDefined();
    expect(def.default).toBe(true);
    for (const p of parsed.personas) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.name).toBe("string");
      expect(typeof p.description).toBe("string");
    }
  });

  it("rejects an unknown persona id on `oracle read`", () => {
    const res = spawnSync(
      process.execPath,
      [CLI, "read", "-", "--offline", "--persona", "not-a-real-persona"],
      { encoding: "utf8", input: FIXTURE },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/unknown persona/);
  });

  it("offline `oracle read --persona=crone` injects crone-flavoured text", () => {
    const res = spawnSync(
      process.execPath,
      [CLI, "read", "-", "--offline", "--persona", "crone"],
      { encoding: "utf8", input: FIXTURE },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/crone/i);
    // archaic word from the crone's offline pack
    expect(res.stdout.toLowerCase()).toMatch(/aye|ye/);
  });

  it("offline `oracle read --persona=bard --json` includes persona id", () => {
    const res = spawnSync(
      process.execPath,
      [CLI, "read", "-", "--offline", "--persona", "bard", "--json"],
      { encoding: "utf8", input: FIXTURE },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.persona).toBe("bard");
    expect(typeof parsed.reading).toBe("string");
    expect(parsed.reading.length).toBeGreaterThan(0);
  });

  it("works with a non-default method (runes) + persona combo", () => {
    const res = spawnSync(
      process.execPath,
      [CLI, "read", "-", "--offline", "--method", "runes", "--persona", "corporate-mystic", "--json"],
      { encoding: "utf8", input: FIXTURE },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.method).toBe("runes");
    expect(parsed.persona).toBe("corporate-mystic");
  });

  it("omitting --persona keeps the default voice (no regression)", () => {
    const res = spawnSync(
      process.execPath,
      [CLI, "read", "-", "--offline", "--json"],
      { encoding: "utf8", input: FIXTURE },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.persona).toBe(DEFAULT_PERSONA_ID);
  });
});
