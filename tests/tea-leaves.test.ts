import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  teaLeaves,
  readLeaves,
  renderTeaLeavesAscii,
  parseDiffStats,
  scoreShapes,
} from "../src/methods/teaLeaves.js";
import { getMethod, listMethods } from "../src/methods/_registry.js";
import { createOfflineClient } from "../src/llm/client.js";

const FIXTURE = readFileSync(resolve(__dirname, "../test/fixtures/multi-file.diff"), "utf8");

describe("methods/tea-leaves registration", () => {
  it("is discovered by the registry", () => {
    expect(getMethod("tea-leaves")?.id).toBe("tea-leaves");
    expect(listMethods().map((m) => m.id)).toContain("tea-leaves");
  });

  it("describe() is non-trivial", () => {
    expect(teaLeaves.describe().length).toBeGreaterThan(20);
  });
});

describe("methods/tea-leaves parseDiffStats", () => {
  it("counts files, additions, deletions, and hunks for the fixture", () => {
    const stats = parseDiffStats(FIXTURE);
    expect(stats.files).toBe(2);
    expect(stats.additions).toBeGreaterThanOrEqual(4);
    expect(stats.deletions).toBeGreaterThanOrEqual(1);
    expect(stats.hunks).toBeGreaterThanOrEqual(2);
    expect(stats.addRatio).toBeGreaterThan(0.5);
  });

  it("empty diff yields a fully zeroed cup", () => {
    const stats = parseDiffStats("");
    expect(stats).toEqual({
      files: 0,
      additions: 0,
      deletions: 0,
      hunks: 0,
      maxHunkLines: 0,
      net: 0,
      addRatio: 0.5,
      dirs: 0,
    });
  });
});

describe("methods/tea-leaves scoreShapes", () => {
  it("favors 'drop' for tiny diffs", () => {
    const tiny = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1,1 @@\n+hi\n`;
    const stats = parseDiffStats(tiny);
    const scores = scoreShapes(stats);
    expect((scores.get("drop") ?? 0)).toBeGreaterThan(0);
  });

  it("favors 'mountain' for very large diffs", () => {
    const big = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -0,0 +1,600 @@"].join("\n") +
      "\n" + "+line\n".repeat(600);
    const stats = parseDiffStats(big);
    const scores = scoreShapes(stats);
    expect((scores.get("mountain") ?? 0)).toBeGreaterThan(0);
  });

  it("favors 'knife' when deletions dominate", () => {
    const cut = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,30 +0,0 @@"].join("\n") +
      "\n" + "-bye\n".repeat(30);
    const stats = parseDiffStats(cut);
    const scores = scoreShapes(stats);
    expect((scores.get("knife") ?? 0)).toBeGreaterThan(0);
  });
});

describe("methods/tea-leaves cast determinism", () => {
  it("same diff yields the same three shapes in the same slots", () => {
    const a = readLeaves(FIXTURE);
    const b = readLeaves(FIXTURE);
    expect(a).toEqual(b);
  });

  it("casts exactly three distinct shapes filling Rim/Side/Bottom", () => {
    const leaves = readLeaves(FIXTURE);
    expect(leaves).toHaveLength(3);
    expect(leaves.map((s) => s.position)).toEqual(["Rim", "Side", "Bottom"]);
    const ids = new Set(leaves.map((s) => s.id));
    expect(ids.size).toBe(3);
    for (const s of leaves) expect(s.id).toMatch(/^leaf:/);
  });

  it("does not lockstep with tarot or runes on the same fixture", async () => {
    const { drawTarot } = await import("../src/methods/tarot.js");
    const { castRunes } = await import("../src/methods/runes.js");
    const leaves = readLeaves(FIXTURE).map((s) => s.id).join(",");
    const tarot = drawTarot(FIXTURE).map((s) => s.id).join(",");
    const runes = castRunes(FIXTURE).map((s) => s.id).join(",");
    expect(leaves).not.toBe(tarot);
    expect(leaves).not.toBe(runes);
    expect(leaves).toMatch(/^leaf:/);
  });
});

describe("methods/tea-leaves ASCII render", () => {
  it("renders a teacup with a stats footer", () => {
    const leaves = readLeaves(FIXTURE);
    const art = renderTeaLeavesAscii(leaves);
    expect(art).toMatch(/stats: \d+ file/);
    expect(art).toMatch(/Rim:/);
    expect(art).toMatch(/Bottom:/);
  });

  it("ASCII cast matches snapshot for the multi-file fixture", () => {
    expect(renderTeaLeavesAscii(readLeaves(FIXTURE))).toMatchSnapshot();
  });
});

describe("methods/tea-leaves reading prompt", () => {
  it("prompt includes each shape with slot and stats line", () => {
    const leaves = readLeaves(FIXTURE);
    const messages = teaLeaves.readingPrompt(leaves, FIXTURE);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("tea leaves");
    expect(messages[0].content).toMatch(/file\(s\)/);
    const user = messages[1].content;
    for (const s of leaves) {
      expect(user).toContain(s.position);
      const meta = s.meta as { shapeName: string };
      expect(user).toContain(meta.shapeName);
    }
  });
});

describe("methods/tea-leaves end-to-end (offline)", () => {
  it("offline reading runs through the full pipeline", async () => {
    const leaves = teaLeaves.draw(FIXTURE);
    const messages = teaLeaves.readingPrompt(leaves, FIXTURE);
    const reading = await createOfflineClient().complete(messages);
    expect(typeof reading).toBe("string");
    expect(reading.length).toBeGreaterThan(0);
  });
});
