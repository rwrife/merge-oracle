import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const CLI = resolve("dist/cli.js");

const MINIMAL_TAROT = {
  id: "cli-tarot",
  name: "CLI-Test Tarot",
  method: "tarot",
  version: 1,
  cards: [
    { id: "a", name: "A", keywords: ["one"], upright: "u", reversed: "r" },
    { id: "b", name: "B", keywords: ["two"], upright: "u", reversed: "r" },
    { id: "c", name: "C", keywords: ["three"], upright: "u", reversed: "r" },
  ],
};

describe("cli: oracle decks", () => {
  const tmps: string[] = [];
  beforeAll(() => {
    if (!existsSync(CLI)) {
      execFileSync("npm", ["run", "build"], { stdio: "ignore" });
    }
  });
  afterEach(() => {
    while (tmps.length) {
      const d = tmps.pop()!;
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("--json emits the registered deck array with envelope fields", () => {
    const out = execFileSync("node", [CLI, "decks", "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    expect(parsed.env).toBe("MERGE_ORACLE_DECKS_DIR");
    expect(Array.isArray(parsed.decks)).toBe(true);
    const ids = parsed.decks.map((d: { id: string }) => d.id);
    expect(ids).toEqual(
      expect.arrayContaining(["major-arcana", "elder-futhark", "i-ching", "tea-leaves", "zodiac"]),
    );
    for (const d of parsed.decks) {
      expect(typeof d.id).toBe("string");
      expect(typeof d.name).toBe("string");
      expect(typeof d.method).toBe("string");
      expect(typeof d.version).toBe("number");
      expect(typeof d.cards).toBe("number");
      expect(["bundled", "env", "arg"]).toContain(d.source);
    }
  });

  it("--method filters the deck list", () => {
    const out = execFileSync("node", [CLI, "decks", "--method", "tarot", "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    expect(parsed.filter).toBe("tarot");
    const ids = parsed.decks.map((d: { id: string }) => d.id);
    expect(ids).toContain("major-arcana");
    expect(ids).not.toContain("elder-futhark");
  });

  it("picks up decks from $MERGE_ORACLE_DECKS_DIR", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "oracle-cli-decks-"));
    tmps.push(dir);
    writeFileSync(resolve(dir, "unit.json"), JSON.stringify(MINIMAL_TAROT));
    const out = execFileSync("node", [CLI, "decks", "--json"], {
      encoding: "utf8",
      env: { ...process.env, MERGE_ORACLE_DECKS_DIR: dir },
    });
    const parsed = JSON.parse(out);
    const found = parsed.decks.find((d: { id: string }) => d.id === "cli-tarot");
    expect(found).toBeTruthy();
    expect(found.source).toBe("env");
    expect(found.sourcePath).toContain(dir);
  });
});

describe("cli: oracle read --deck", () => {
  const tmps: string[] = [];
  beforeAll(() => {
    if (!existsSync(CLI)) {
      execFileSync("npm", ["run", "build"], { stdio: "ignore" });
    }
  });
  afterEach(() => {
    while (tmps.length) {
      const d = tmps.pop()!;
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("reads from a custom deck by path and surfaces it in --json output", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "oracle-cli-deck-read-"));
    tmps.push(dir);
    const path = resolve(dir, "tiny.json");
    writeFileSync(path, JSON.stringify(MINIMAL_TAROT));
    const out = execFileSync(
      "node",
      [
        CLI,
        "read",
        resolve("test/fixtures/simple.diff"),
        "--method",
        "tarot",
        "--deck",
        path,
        "--offline",
        "--no-history",
        "--json",
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(out);
    expect(parsed.deck).toEqual(
      expect.objectContaining({ id: "cli-tarot", source: "arg", sourcePath: path }),
    );
    // Every symbol drawn should be from the custom deck.
    for (const s of parsed.symbols) {
      expect(["arcana:a", "arcana:b", "arcana:c"]).toContain(s.id);
    }
  });

  it("exits non-zero when --deck references an unknown id and no file", () => {
    let exit = 0;
    try {
      execFileSync(
        "node",
        [
          CLI,
          "read",
          resolve("test/fixtures/simple.diff"),
          "--method",
          "tarot",
          "--deck",
          "definitely-does-not-exist-xyz",
          "--offline",
          "--no-history",
        ],
        { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (err) {
      exit = (err as { status?: number }).status ?? -1;
    }
    expect(exit).not.toBe(0);
  });

  it("exits non-zero when --deck method mismatches the chosen method", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "oracle-cli-deck-mismatch-"));
    tmps.push(dir);
    const path = resolve(dir, "tarot.json");
    writeFileSync(path, JSON.stringify(MINIMAL_TAROT));
    let exit = 0;
    try {
      execFileSync(
        "node",
        [
          CLI,
          "read",
          resolve("test/fixtures/simple.diff"),
          "--method",
          "runes",
          "--deck",
          path,
          "--offline",
          "--no-history",
        ],
        { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (err) {
      exit = (err as { status?: number }).status ?? -1;
    }
    expect(exit).not.toBe(0);
  });
});
