import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { drawTarot, renderTarotAscii, tarot, TAROT_SPREADS } from "../src/methods/tarot.js";
import { countDiffLoc, isBigDiff, resolveSpread, DEFAULT_BIG_PR_THRESHOLD } from "../src/spreads.js";
import { createOfflineClient } from "../src/llm/client.js";

const FIXTURE = readFileSync(resolve(__dirname, "../test/fixtures/multi-file.diff"), "utf8");
const CLI = resolve("dist/cli.js");

function bigDiff(loc: number): string {
  // Synthesize a diff with `loc` additions so countDiffLoc reports >= loc.
  const header = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1," + loc + " @@\n";
  const body = Array.from({ length: loc }, (_, i) => `+line ${i}`).join("\n");
  return header + body + "\n";
}

describe("spreads/countDiffLoc", () => {
  it("counts + and - lines, ignoring file headers", () => {
    const diff = ["--- a/foo", "+++ b/foo", "@@ -1,2 +1,3 @@", "+added", "-removed", " context"].join("\n");
    expect(countDiffLoc(diff)).toBe(2);
  });

  it("isBigDiff respects threshold", () => {
    expect(isBigDiff(bigDiff(100), 50)).toBe(true);
    expect(isBigDiff(bigDiff(10), 50)).toBe(false);
  });
});

describe("spreads/resolveSpread", () => {
  it("honors explicit requested spread when supported", () => {
    const res = resolveSpread({
      supportedSpreads: TAROT_SPREADS,
      requested: "celtic-cross",
      diff: "",
    });
    expect(res.spread).toBe("celtic-cross");
    expect(res.autoUpgraded).toBe(false);
  });

  it("auto-upgrades to celtic-cross when diff exceeds threshold", () => {
    const res = resolveSpread({
      supportedSpreads: TAROT_SPREADS,
      diff: bigDiff(DEFAULT_BIG_PR_THRESHOLD + 50),
    });
    expect(res.spread).toBe("celtic-cross");
    expect(res.autoUpgraded).toBe(true);
  });

  it("does NOT auto-upgrade for small diffs", () => {
    const res = resolveSpread({
      supportedSpreads: TAROT_SPREADS,
      diff: bigDiff(5),
    });
    expect(res.spread).toBe("three-card");
    expect(res.autoUpgraded).toBe(false);
  });

  it("explicit three-card overrides auto-upgrade on big diff", () => {
    const res = resolveSpread({
      supportedSpreads: TAROT_SPREADS,
      requested: "three-card",
      diff: bigDiff(DEFAULT_BIG_PR_THRESHOLD + 50),
    });
    expect(res.spread).toBe("three-card");
    expect(res.autoUpgraded).toBe(false);
  });

  it("respects custom threshold", () => {
    const res = resolveSpread({
      supportedSpreads: TAROT_SPREADS,
      diff: bigDiff(60),
      threshold: 50,
    });
    expect(res.spread).toBe("celtic-cross");
    expect(res.autoUpgraded).toBe(true);
  });
});

describe("methods/tarot celtic cross", () => {
  it("declares both three-card and celtic-cross spreads", () => {
    expect(tarot.supportedSpreads?.map((s) => s.id)).toEqual(["three-card", "celtic-cross"]);
    expect(tarot.supportedSpreads?.find((s) => s.id === "three-card")?.default).toBe(true);
  });

  it("draws 10 distinct cards in canonical slot order for celtic-cross", () => {
    const cards = drawTarot(FIXTURE, { spread: "celtic-cross" });
    expect(cards).toHaveLength(10);
    expect(cards.map((c) => c.position)).toEqual([
      "Significator",
      "Challenge",
      "Foundation",
      "Recent Past",
      "Crown",
      "Near Future",
      "Self",
      "Environment",
      "Hopes/Fears",
      "Outcome",
    ]);
    const ids = new Set(cards.map((c) => c.id));
    expect(ids.size).toBe(10);
  });

  it("celtic-cross draw is deterministic and differs from three-card on same diff", () => {
    const a = drawTarot(FIXTURE, { spread: "celtic-cross" });
    const b = drawTarot(FIXTURE, { spread: "celtic-cross" });
    const three = drawTarot(FIXTURE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(three));
  });

  it("renders a celtic-cross layout with cross + staff", () => {
    const cards = drawTarot(FIXTURE, { spread: "celtic-cross" });
    const art = renderTarotAscii(cards);
    // Should reference each slot label in the legend.
    for (const c of cards) expect(art).toContain(c.position);
    // The challenge note marks the cross.
    expect(art).toContain("Cross");
  });

  it("reading prompt mentions celtic cross for the 10-card spread", () => {
    const cards = drawTarot(FIXTURE, { spread: "celtic-cross" });
    const messages = tarot.readingPrompt(cards, FIXTURE, { spread: "celtic-cross" });
    expect(messages[0].content).toMatch(/Celtic Cross/i);
    expect(messages[1].content).toContain("Outcome");
  });

  it("offline mode still produces output for celtic-cross spread", async () => {
    const cards = tarot.draw(FIXTURE, { spread: "celtic-cross" });
    const messages = tarot.readingPrompt(cards, FIXTURE, { spread: "celtic-cross" });
    const reading = await createOfflineClient().complete(messages);
    expect(typeof reading).toBe("string");
    expect(reading.length).toBeGreaterThan(0);
  });
});

describe("cli: spread integration", () => {
  it("--spread=celtic-cross emits 10 symbols in --json", () => {
    if (!existsSync(CLI)) execFileSync("npm", ["run", "build"], { stdio: "ignore" });
    const diffPath = resolve(__dirname, "../test/fixtures/multi-file.diff");
    const out = execFileSync(
      "node",
      [CLI, "read", diffPath, "--method=tarot", "--spread=celtic-cross", "--offline", "--json"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(out);
    expect(parsed.spread).toBe("celtic-cross");
    expect(parsed.symbols).toHaveLength(10);
    expect(parsed.spreadAutoUpgraded).toBe(false);
  });

  it("methods --json reports supportedSpreads for tarot", () => {
    if (!existsSync(CLI)) execFileSync("npm", ["run", "build"], { stdio: "ignore" });
    const out = execFileSync("node", [CLI, "methods", "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    const t = parsed.methods.find((m: { id: string }) => m.id === "tarot");
    expect(t).toBeDefined();
    expect(t.supportedSpreads.map((s: { id: string }) => s.id)).toEqual([
      "three-card",
      "celtic-cross",
    ]);
  });

  it("unknown spread is rejected with non-zero exit", () => {
    if (!existsSync(CLI)) execFileSync("npm", ["run", "build"], { stdio: "ignore" });
    const diffPath = resolve(__dirname, "../test/fixtures/multi-file.diff");
    let threw = false;
    try {
      execFileSync(
        "node",
        [CLI, "read", diffPath, "--method=tarot", "--spread=nope", "--offline"],
        { encoding: "utf8", stdio: "pipe" },
      );
    } catch (err) {
      threw = true;
      const e = err as { status: number; stderr: Buffer };
      expect(e.status).toBe(2);
      expect(e.stderr.toString()).toMatch(/unknown spread/i);
    }
    expect(threw).toBe(true);
  });
});
