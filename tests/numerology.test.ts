import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  numerology,
  castNumerology,
  computeChart,
  reduceNumber,
  longestAdditionRun,
  renderNumerologyAscii,
} from "../src/methods/numerology.js";
import { getMethod, listMethods } from "../src/methods/_registry.js";
import { createOfflineClient } from "../src/llm/client.js";

const FIXTURE = readFileSync(resolve(__dirname, "../test/fixtures/multi-file.diff"), "utf8");

describe("methods/numerology registration", () => {
  it("is discovered by the registry", () => {
    expect(getMethod("numerology")?.id).toBe("numerology");
    expect(listMethods().map((m) => m.id)).toContain("numerology");
  });

  it("describe() is non-trivial", () => {
    expect(numerology.describe().length).toBeGreaterThan(20);
  });
});

describe("methods/numerology reduceNumber", () => {
  it("reduces multi-digit numbers to a single digit", () => {
    expect(reduceNumber(1)).toBe(1);
    expect(reduceNumber(9)).toBe(9);
    expect(reduceNumber(10)).toBe(1);
    expect(reduceNumber(28)).toBe(1); // 2+8=10 -> 1
    expect(reduceNumber(99)).toBe(9); // 9+9=18 -> 9
    expect(reduceNumber(123)).toBe(6);
  });

  it("preserves master numbers 11, 22, 33", () => {
    expect(reduceNumber(11)).toBe(11);
    expect(reduceNumber(22)).toBe(22);
    expect(reduceNumber(33)).toBe(33);
    // Reductions that pass through a master on their way down stop there.
    expect(reduceNumber(29)).toBe(11); // 2+9 = 11 (master, stop)
    expect(reduceNumber(499)).toBe(22); // 4+9+9 = 22 (master, stop)
    expect(reduceNumber(8889)).toBe(33); // 8+8+8+9 = 33 (master, stop)
    // Non-master multi-digit reductions go all the way down.
    expect(reduceNumber(49)).toBe(4); // 4+9 = 13 -> 1+3 = 4
  });

  it("zero collapses to zero", () => {
    expect(reduceNumber(0)).toBe(0);
  });
});

describe("methods/numerology longestAdditionRun", () => {
  it("ignores +++ headers", () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n+a\n+b\n+c\n-x\n+d\n";
    expect(longestAdditionRun(diff)).toBe(3);
  });

  it("returns 0 when no additions", () => {
    expect(longestAdditionRun("")).toBe(0);
  });
});

describe("methods/numerology computeChart determinism", () => {
  it("same diff yields the same chart", () => {
    const a = computeChart(FIXTURE);
    const b = computeChart(FIXTURE);
    expect(a).toEqual(b);
  });

  it("chart numbers are all in {0..9, 11, 22, 33}", () => {
    const valid = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 22, 33]);
    const c = computeChart(FIXTURE);
    for (const n of [c.lifePath, c.expression, c.soulUrge, c.personality]) {
      expect(valid.has(n)).toBe(true);
    }
  });
});

describe("methods/numerology cast", () => {
  it("casts four symbols in the canonical slot order", () => {
    const drawn = castNumerology(FIXTURE);
    expect(drawn).toHaveLength(4);
    expect(drawn.map((s) => s.position)).toEqual([
      "Life Path",
      "Expression",
      "Soul Urge",
      "Personality",
    ]);
    for (const s of drawn) expect(s.id).toMatch(/^num:/);
  });

  it("snapshot of the cast for the multi-file fixture", () => {
    expect(castNumerology(FIXTURE)).toMatchSnapshot();
  });
});

describe("methods/numerology ASCII render", () => {
  it("renders a 4-square chart with the raw inputs footer", () => {
    const drawn = castNumerology(FIXTURE);
    const art = renderNumerologyAscii(drawn);
    expect(art).toMatch(/Life Path/);
    expect(art).toMatch(/Personality/);
    expect(art).toMatch(/inputs: churn=/);
  });

  it("ASCII chart matches snapshot for the multi-file fixture", () => {
    expect(renderNumerologyAscii(castNumerology(FIXTURE))).toMatchSnapshot();
  });
});

describe("methods/numerology reading prompt", () => {
  it("prompt mentions every slot and the inputs line", () => {
    const drawn = castNumerology(FIXTURE);
    const messages = numerology.readingPrompt(drawn, FIXTURE);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("numerology");
    expect(messages[0].content).toMatch(/Raw inputs:/);
    const user = messages[1].content;
    for (const s of drawn) expect(user).toContain(s.position);
  });
});

describe("methods/numerology end-to-end (offline)", () => {
  it("offline reading runs through the full pipeline without network", async () => {
    const drawn = numerology.draw(FIXTURE);
    const messages = numerology.readingPrompt(drawn, FIXTURE);
    const reading = await createOfflineClient().complete(messages);
    expect(typeof reading).toBe("string");
    expect(reading.length).toBeGreaterThan(0);
  });
});
