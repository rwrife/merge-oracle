import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const CLI = resolve("dist/cli.js");

describe("cli: oracle methods --json", () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      execFileSync("npm", ["run", "build"], { stdio: "ignore" });
    }
  });

  it("emits a JSON payload with default + methods array", () => {
    const out = execFileSync("node", [CLI, "methods", "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    expect(typeof parsed.default).toBe("string");
    expect(Array.isArray(parsed.methods)).toBe(true);
    expect(parsed.methods.length).toBeGreaterThanOrEqual(2);
    for (const m of parsed.methods) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.name).toBe("string");
      expect(typeof m.description).toBe("string");
      expect(typeof m.default).toBe("boolean");
    }
    const ids = parsed.methods.map((m: { id: string }) => m.id);
    expect(ids).toContain("tarot");
    expect(ids).toContain("runes");
    const defaults = parsed.methods.filter((m: { default: boolean }) => m.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(parsed.default);
  });

  it("plain text output is unchanged when --json is absent", () => {
    const out = execFileSync("node", [CLI, "methods"], { encoding: "utf8" });
    expect(out).toMatch(/tarot/);
    expect(out).toMatch(/runes/);
    expect(() => JSON.parse(out)).toThrow();
  });
});
