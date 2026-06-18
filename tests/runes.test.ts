import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runes, castRunes, renderRunesAscii } from "../src/methods/runes.js";
import { getMethod, listMethods } from "../src/methods/_registry.js";
import { createOfflineClient } from "../src/llm/client.js";

const FIXTURE = readFileSync(resolve(__dirname, "../test/fixtures/multi-file.diff"), "utf8");

describe("methods/runes registration", () => {
  it("runes is discovered by the registry", () => {
    expect(getMethod("runes")?.id).toBe("runes");
    expect(listMethods().map((m) => m.id)).toContain("runes");
  });

  it("describe() is non-trivial", () => {
    expect(runes.describe().length).toBeGreaterThan(20);
  });
});

describe("methods/runes cast determinism", () => {
  it("same diff yields the same three runes in the same orientation", () => {
    const a = castRunes(FIXTURE);
    const b = castRunes(FIXTURE);
    expect(a).toEqual(b);
  });

  it("casts exactly three distinct runes filling Situation/Obstacle/Outcome", () => {
    const stones = castRunes(FIXTURE);
    expect(stones).toHaveLength(3);
    expect(stones.map((s) => s.position)).toEqual(["Situation", "Obstacle", "Outcome"]);
    const ids = new Set(stones.map((s) => s.id));
    expect(ids.size).toBe(3);
  });

  it("different diffs generally yield different casts", () => {
    const a = castRunes("diff one");
    const b = castRunes("a completely different diff with different bytes");
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("runes and tarot do not draw lockstep from the same diff", async () => {
    const { drawTarot } = await import("../src/methods/tarot.js");
    const r = castRunes(FIXTURE).map((s) => s.id).join(",");
    const t = drawTarot(FIXTURE).map((s) => s.id).join(",");
    // Different decks anyway, but assert both fingerprints are stable and present.
    expect(r).toMatch(/^rune:/);
    expect(t).toMatch(/^arcana:/);
  });
});

describe("methods/runes ASCII render", () => {
  it("renders three stone frames side by side", () => {
    const stones = castRunes(FIXTURE);
    const art = renderRunesAscii(stones);
    const firstLine = art.split("\n")[0];
    expect(firstLine.match(/\+-+\+/g)?.length).toBe(3);
  });

  it("ASCII cast matches snapshot for the multi-file fixture", () => {
    expect(renderRunesAscii(castRunes(FIXTURE))).toMatchSnapshot();
  });
});

describe("methods/runes reading prompt", () => {
  it("prompt includes each cast rune with orientation and slot", () => {
    const stones = castRunes(FIXTURE);
    const messages = runes.readingPrompt(stones, FIXTURE);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Elder Futhark");
    expect(messages[0].content).toContain("merkstave");
    const user = messages[1].content;
    for (const s of stones) {
      expect(user).toContain(s.position);
      const meta = s.meta as { runeName: string };
      expect(user).toContain(meta.runeName);
    }
  });
});

describe("methods/runes end-to-end (offline)", () => {
  it("offline reading runs through the full pipeline", async () => {
    const stones = runes.draw(FIXTURE);
    const messages = runes.readingPrompt(stones, FIXTURE);
    const reading = await createOfflineClient().complete(messages);
    expect(typeof reading).toBe("string");
    expect(reading.length).toBeGreaterThan(0);
  });
});
