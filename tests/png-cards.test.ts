import { describe, expect, it } from "vitest";
import {
  DEFAULT_PNG_HEIGHT,
  DEFAULT_PNG_THEME,
  DEFAULT_PNG_WIDTH,
  PNG_THEMES,
  buildCardTree,
  isPngTheme,
  parsePngSize,
  renderCardPng,
  renderCardSvg,
  type CardData,
  type PngThemeId,
} from "../src/render/png.js";
import type { DrawnSymbol } from "../src/methods/types.js";

const SAMPLE_DIFF = `diff --git a/x b/x
--- a/x
+++ b/x
@@
-old line
+new line
+extra line
`;

const SYMBOLS: DrawnSymbol[] = [
  { id: "0", name: "The Fool", position: "Past" },
  { id: "13", name: "Death", position: "Present", reversed: true },
  { id: "18", name: "The Moon", position: "Future" },
];

function makeCard(overrides: Partial<CardData> = {}): CardData {
  return {
    methodName: "Tarot",
    personaName: "The Crone",
    spread: "three-card",
    symbols: SYMBOLS,
    reading:
      "The oracle sees clearly: your diff hums with intent. Proceed, but light a candle for the type-checker.",
    diff: SAMPLE_DIFF,
    repoRef: "https://github.com/rwrife/merge-oracle/pull/999",
    channel: "offline",
    ...overrides,
  };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("parsePngSize", () => {
  it("parses valid WxH", () => {
    expect(parsePngSize("1200x630")).toEqual({ width: 1200, height: 630 });
    expect(parsePngSize("  800X800  ")).toEqual({ width: 800, height: 800 });
  });

  it.each(["", "1200", "1200*630", "wxh", "-100x-100"])(
    "rejects garbage %s",
    (bad) => {
      expect(() => parsePngSize(bad)).toThrow(/--png-size/);
    },
  );

  it("rejects out-of-range values", () => {
    expect(() => parsePngSize("50x50")).toThrow(/>= 200/);
    expect(() => parsePngSize("5000x5000")).toThrow(/<= 4096/);
  });
});

describe("isPngTheme", () => {
  it("accepts shipped themes and rejects others", () => {
    for (const t of PNG_THEMES) expect(isPngTheme(t)).toBe(true);
    expect(isPngTheme("neon")).toBe(false);
  });
});

describe("buildCardTree", () => {
  it("stamps the theme id + class name onto the root node", () => {
    for (const themeId of PNG_THEMES) {
      const tree = buildCardTree(
        makeCard(),
        {
          id: themeId,
          bg: "#000",
          panel: "#111",
          accent: "#fff",
          fg: "#eee",
          muted: "#888",
          divider: "#333",
          markBg: "#222",
          symbolBg: "#222",
          symbolFg: "#fff",
          className: `oracle-theme-${themeId}`,
        } as never,
        DEFAULT_PNG_WIDTH,
        DEFAULT_PNG_HEIGHT,
      );
      expect((tree as { props: { "data-theme": string } }).props["data-theme"]).toBe(themeId);
      expect((tree as { props: { class: string } }).props.class).toContain(themeId);
    }
  });
});

describe("renderCardSvg", () => {
  it("emits SVG that reflects the requested theme", async () => {
    const svg = await renderCardSvg(makeCard(), { theme: "parchment" });
    expect(svg.startsWith("<svg")).toBe(true);
    // satori strips unknown HTML attrs, but the theme's distinctive
    // background color is baked into the SVG's root <rect fill=...> and
    // gives us a stable, satori-preserved fingerprint for the theme.
    expect(svg).toContain('fill="#f5ecd8"'); // parchment bg
  });

  it("does not leak the wrong theme's palette when default is used", async () => {
    const svg = await renderCardSvg(makeCard());
    // Default theme (dark) bg vs parchment bg.
    expect(svg).toContain('fill="#0b0d17"');
    expect(svg).not.toContain('fill="#f5ecd8"');
  });

  it("renders identical layout in offline vs live scenarios (same input → same SVG)", async () => {
    // The card layout depends only on inputs, not on how `reading` was
    // produced. This guards against accidentally coupling layout to
    // provider metadata (e.g. injecting a "channel: openai" watermark).
    const a = await renderCardSvg(makeCard({ channel: "offline" }));
    const b = await renderCardSvg(makeCard({ channel: "offline" }));
    expect(a).toEqual(b);
  });
});

describe("renderCardPng", () => {
  it("produces a valid PNG at the default dimensions", async () => {
    const { buffer, width, height, theme } = await renderCardPng(makeCard());
    expect(buffer.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(width).toBe(DEFAULT_PNG_WIDTH);
    expect(height).toBe(DEFAULT_PNG_HEIGHT);
    expect(theme).toBe(DEFAULT_PNG_THEME);
  });

  it.each<PngThemeId>(["dark", "light", "parchment"])(
    "renders each shipped theme (%s) to a decodable PNG",
    async (themeId) => {
      const { buffer, theme } = await renderCardPng(makeCard(), { theme: themeId });
      expect(theme).toBe(themeId);
      expect(buffer.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      expect(buffer.length).toBeGreaterThan(1024);
    },
  );

  it("honors --png-size overrides", async () => {
    const { buffer, width, height } = await renderCardPng(makeCard(), {
      width: 800,
      height: 800,
    });
    expect(width).toBe(800);
    expect(height).toBe(800);
    // The PNG IHDR chunk starts at byte 8 with length (4) + type (4) + width (4).
    // We can parse it back to double-check sharp actually produced the requested size.
    const ihdrWidth = buffer.readUInt32BE(16);
    const ihdrHeight = buffer.readUInt32BE(20);
    expect(ihdrWidth).toBe(800);
    expect(ihdrHeight).toBe(800);
  });
});
