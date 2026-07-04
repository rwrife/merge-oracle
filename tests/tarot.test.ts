import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tarot, drawTarot, hashDiff, renderTarotAscii } from "../src/methods/tarot.js";
import { getMethod, listMethods, DEFAULT_METHOD_ID } from "../src/methods/_registry.js";
import { createOfflineClient } from "../src/llm/client.js";

const FIXTURE = readFileSync(resolve(__dirname, "../test/fixtures/multi-file.diff"), "utf8");

describe("methods/registry", () => {
  it("default method id resolves to tarot", () => {
    expect(DEFAULT_METHOD_ID).toBe("tarot");
    expect(getMethod(DEFAULT_METHOD_ID)?.id).toBe("tarot");
  });

  it("listMethods includes tarot with a non-empty description", () => {
    const ids = listMethods().map((m) => m.id);
    expect(ids).toContain("tarot");
    expect(getMethod("tarot")!.describe().length).toBeGreaterThan(10);
  });

  it("returns undefined for unknown methods", () => {
    expect(getMethod("cartomancy")).toBeUndefined();
  });
});

describe("methods/tarot draw determinism", () => {
  it("same diff yields the same three cards in the same orientation", () => {
    const a = drawTarot(FIXTURE);
    const b = drawTarot(FIXTURE);
    expect(a).toEqual(b);
  });

  it("draws exactly three distinct cards filling Past/Present/Future", () => {
    const cards = drawTarot(FIXTURE);
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.position)).toEqual(["Past", "Present", "Future"]);
    const ids = new Set(cards.map((c) => c.id));
    expect(ids.size).toBe(3);
  });

  it("different diffs generally yield different draws", () => {
    const a = drawTarot("diff one");
    const b = drawTarot("a completely different diff with different bytes");
    // Compare as JSON so we capture cards + orientations.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("hashDiff is stable and 32-bit unsigned", () => {
    const h = hashDiff(FIXTURE);
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
    expect(h).toBe(hashDiff(FIXTURE));
  });
});

describe("methods/tarot ASCII render", () => {
  it("renders three card frames side by side", () => {
    const cards = drawTarot(FIXTURE);
    const art = renderTarotAscii(cards);
    // Three card tops on the first line.
    const firstLine = art.split("\n")[0];
    expect(firstLine.match(/\+-+\+/g)?.length).toBe(3);
    // Each card's name should appear somewhere in the art.
    for (const c of cards) {
      expect(art).toContain(c.name.split(" ")[0]); // first word survives flipping check below
    }
  });

  it("ASCII spread matches snapshot for the multi-file fixture", () => {
    const cards = drawTarot(FIXTURE);
    expect(renderTarotAscii(cards)).toMatchSnapshot();
  });
});

describe("methods/tarot reading prompt", () => {
  it("prompt includes each drawn symbol with orientation and slot", () => {
    const cards = drawTarot(FIXTURE);
    const messages = tarot.readingPrompt(cards, FIXTURE);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("3-card Major Arcana");
    const user = messages[1].content;
    for (const c of cards) {
      expect(user).toContain(c.position);
      expect(user).toContain(c.name);
      expect(user).toContain(c.reversed ? "reversed" : "upright");
    }
    expect(user).toContain("Verdict" /* hinted in extraSystem */ === "Verdict" ? "Diff" : "Diff");
  });
});

describe("methods/tarot end-to-end (offline)", () => {
  it("offline reading runs through the full pipeline", async () => {
    const cards = tarot.draw(FIXTURE);
    const messages = tarot.readingPrompt(cards, FIXTURE);
    const reading = await createOfflineClient().complete(messages);
    expect(typeof reading).toBe("string");
    expect(reading.length).toBeGreaterThan(0);
  });

  it("offline reading is stable for a fixed diff (snapshot)", async () => {
    const cards = tarot.draw(FIXTURE);
    const messages = tarot.readingPrompt(cards, FIXTURE);
    const reading = await createOfflineClient().complete(messages);
    expect({ cards: cards.map(({ id, name, position, reversed }) => ({ id, name, position, reversed })), reading }).toMatchSnapshot();
  });
});
