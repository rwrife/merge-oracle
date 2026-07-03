/**
 * Shareable PNG "reading cards" — render an oracle reading to an
 * OpenGraph-friendly PNG via satori (JSX → SVG) + sharp (SVG → PNG).
 *
 * Designed to be:
 *  - self-contained (fonts bundled under src/data/fonts/, no network)
 *  - deterministic given the same input (satori/sharp are pure)
 *  - offline-safe (identical layout regardless of whether the reading
 *    came from a live LLM or the offline mock)
 */
import satori from "satori";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { DrawnSymbol } from "../methods/types.js";
import { countDiffLoc } from "../spreads.js";

export const DEFAULT_PNG_WIDTH = 1200;
export const DEFAULT_PNG_HEIGHT = 630;
export const DEFAULT_PNG_THEME: PngThemeId = "dark";

export type PngThemeId = "dark" | "light" | "parchment";

interface Palette {
  id: PngThemeId;
  bg: string;
  panel: string;
  accent: string;
  fg: string;
  muted: string;
  divider: string;
  markBg: string;
  symbolBg: string;
  symbolFg: string;
  className: string; // for testable "theme selector" hooks in the SVG
}

const THEMES: Record<PngThemeId, Palette> = {
  dark: {
    id: "dark",
    bg: "#0b0d17",
    panel: "#141826",
    accent: "#c4b5fd",
    fg: "#e8ecf5",
    muted: "#8a91a8",
    divider: "#242942",
    markBg: "#1c2140",
    symbolBg: "#1a1f36",
    symbolFg: "#f5d76e",
    className: "oracle-theme-dark",
  },
  light: {
    id: "light",
    bg: "#fafbff",
    panel: "#ffffff",
    accent: "#5b21b6",
    fg: "#0f1226",
    muted: "#4a5170",
    divider: "#e2e5f0",
    markBg: "#eef0fb",
    symbolBg: "#f2eefc",
    symbolFg: "#5b21b6",
    className: "oracle-theme-light",
  },
  parchment: {
    id: "parchment",
    bg: "#f5ecd8",
    panel: "#fbf5e4",
    accent: "#7a3b0f",
    fg: "#2b1a08",
    muted: "#7a6b4f",
    divider: "#d9c9a2",
    markBg: "#eddfbe",
    symbolBg: "#e6d4a5",
    symbolFg: "#7a3b0f",
    className: "oracle-theme-parchment",
  },
};

const THEME_IDS = Object.keys(THEMES) as PngThemeId[];
export const PNG_THEMES: ReadonlyArray<PngThemeId> = THEME_IDS;

export function isPngTheme(value: string): value is PngThemeId {
  return (THEME_IDS as string[]).includes(value);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = resolve(HERE, "../data/fonts");

let cachedFonts: { regular: Buffer; bold: Buffer } | null = null;

function loadFonts(): { regular: Buffer; bold: Buffer } {
  if (cachedFonts) return cachedFonts;
  const regular = readFileSync(resolve(FONT_DIR, "inter-latin-400.woff"));
  const bold = readFileSync(resolve(FONT_DIR, "inter-latin-700.woff"));
  cachedFonts = { regular, bold };
  return cachedFonts;
}

export interface ParsedPngSize {
  width: number;
  height: number;
}

/**
 * Parse a `--png-size` value like `1200x630`, returning a normalized
 * {width,height}. Throws on invalid input so the CLI can surface a clear
 * error rather than silently defaulting.
 */
export function parsePngSize(value: string): ParsedPngSize {
  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+)x(\d+)$/.exec(trimmed);
  if (!match) {
    throw new Error(`--png-size must look like WxH (e.g. 1200x630), got "${value}"`);
  }
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 200) {
    throw new Error(`--png-size width/height must be integers >= 200, got ${width}x${height}`);
  }
  if (width > 4096 || height > 4096) {
    throw new Error(`--png-size width/height must be <= 4096, got ${width}x${height}`);
  }
  return { width, height };
}

export interface CardData {
  methodName: string;
  personaName: string;
  spread: string | null;
  symbols: DrawnSymbol[];
  reading: string;
  diff: string;
  repoRef: string | null;
  channel: string;
}

interface RenderOptions {
  theme?: PngThemeId;
  width?: number;
  height?: number;
}

/**
 * Build the satori "JSX" tree for a reading card. Exposed for tests so we
 * can assert that theme selectors and content make it into the SVG.
 */
export function buildCardTree(card: CardData, palette: Palette, width: number, height: number) {
  const scale = width / DEFAULT_PNG_WIDTH;
  const px = (n: number) => Math.round(n * scale);
  const loc = countDiffLoc(card.diff);
  const readingText = card.reading.trim();
  // Trim to something that fits without overflowing the card. satori
  // handles wrapping fine, but very long readings would overflow height.
  const readingClipped =
    readingText.length > 900 ? `${readingText.slice(0, 897).trimEnd()}…` : readingText;
  const symbolBadges = card.symbols.slice(0, 6).map((s) => ({
    label: s.name,
    slot: s.position,
    reversed: s.reversed === true,
  }));
  const footerLeft = [`${loc} LoC changed`, card.repoRef ?? "no repo ref", `channel: ${card.channel}`].join("  •  ");

  const rootStyle = {
    width: `${width}px`,
    height: `${height}px`,
    display: "flex",
    flexDirection: "column" as const,
    fontFamily: "Inter",
    backgroundColor: palette.bg,
    color: palette.fg,
    padding: `${px(48)}px`,
    boxSizing: "border-box" as const,
  };

  // The wrapper carries the theme id + class name so tests can grep the SVG.
  return {
    type: "div",
    key: null,
    props: {
      "data-theme": palette.id,
      class: palette.className,
      style: rootStyle,
      children: [
        // Header
        {
          type: "div",
          key: "header",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: `${px(24)}px`,
            },
            children: [
              {
                type: "div",
                key: "title",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                  },
                  children: [
                    {
                      type: "div",
                      key: "brand",
                      props: {
                        style: {
                          color: palette.accent,
                          fontSize: `${px(18)}px`,
                          fontWeight: 700,
                          letterSpacing: `${px(2)}px`,
                          textTransform: "uppercase" as const,
                        },
                        children: "🔮 merge-oracle",
                      },
                    },
                    {
                      type: "div",
                      key: "method",
                      props: {
                        style: {
                          fontSize: `${px(40)}px`,
                          fontWeight: 700,
                          marginTop: `${px(6)}px`,
                        },
                        children: card.methodName,
                      },
                    },
                    {
                      type: "div",
                      key: "sub",
                      props: {
                        style: {
                          color: palette.muted,
                          fontSize: `${px(18)}px`,
                          marginTop: `${px(4)}px`,
                        },
                        children: [
                          `persona: ${card.personaName}`,
                          card.spread ? `  •  spread: ${card.spread}` : "",
                        ].join(""),
                      },
                    },
                  ],
                },
              },
              {
                type: "div",
                key: "mark",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: palette.markBg,
                    color: palette.accent,
                    borderRadius: `${px(999)}px`,
                    padding: `${px(10)}px ${px(18)}px`,
                    fontSize: `${px(16)}px`,
                    fontWeight: 700,
                  },
                  children: "READING",
                },
              },
            ],
          },
        },
        // Symbols row
        {
          type: "div",
          key: "symbols",
          props: {
            style: {
              display: "flex",
              flexWrap: "wrap" as const,
              gap: `${px(12)}px`,
              marginBottom: `${px(20)}px`,
            },
            children: symbolBadges.map((sym, i) => ({
              type: "div",
              key: `sym-${i}`,
              props: {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  backgroundColor: palette.symbolBg,
                  color: palette.symbolFg,
                  borderRadius: `${px(12)}px`,
                  padding: `${px(10)}px ${px(14)}px`,
                  minWidth: `${px(160)}px`,
                },
                children: [
                  {
                    type: "div",
                    key: "slot",
                    props: {
                      style: {
                        color: palette.muted,
                        fontSize: `${px(12)}px`,
                        textTransform: "uppercase" as const,
                        letterSpacing: `${px(1)}px`,
                      },
                      children: sym.slot,
                    },
                  },
                  {
                    type: "div",
                    key: "name",
                    props: {
                      style: {
                        fontSize: `${px(18)}px`,
                        fontWeight: 700,
                        marginTop: `${px(4)}px`,
                      },
                      children: `${sym.label}${sym.reversed ? " (rev.)" : ""}`,
                    },
                  },
                ],
              },
            })),
          },
        },
        // Body — reading text panel
        {
          type: "div",
          key: "body",
          props: {
            style: {
              display: "flex",
              flexGrow: 1,
              backgroundColor: palette.panel,
              borderRadius: `${px(16)}px`,
              padding: `${px(24)}px ${px(28)}px`,
              fontSize: `${px(20)}px`,
              lineHeight: 1.45,
              color: palette.fg,
              overflow: "hidden" as const,
            },
            children: readingClipped,
          },
        },
        // Footer
        {
          type: "div",
          key: "footer",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: `${px(20)}px`,
              paddingTop: `${px(16)}px`,
              borderTop: `1px solid ${palette.divider}`,
              color: palette.muted,
              fontSize: `${px(16)}px`,
            },
            children: [
              {
                type: "div",
                key: "footL",
                props: {
                  style: { display: "flex" },
                  children: footerLeft,
                },
              },
              {
                type: "div",
                key: "footR",
                props: {
                  style: {
                    display: "flex",
                    color: palette.accent,
                    fontWeight: 700,
                  },
                  children: "rwrife/merge-oracle",
                },
              },
            ],
          },
        },
      ],
    },
  };
}

/**
 * Render a reading card to SVG. Exported for tests / advanced callers who
 * want the raw SVG (e.g. to further transform).
 */
export async function renderCardSvg(card: CardData, opts: RenderOptions = {}): Promise<string> {
  const themeId = opts.theme && isPngTheme(opts.theme) ? opts.theme : DEFAULT_PNG_THEME;
  const palette = THEMES[themeId];
  const width = opts.width ?? DEFAULT_PNG_WIDTH;
  const height = opts.height ?? DEFAULT_PNG_HEIGHT;
  const { regular, bold } = loadFonts();
  const tree = buildCardTree(card, palette, width, height);
  const svg = await satori(tree as unknown as never, {
    width,
    height,
    fonts: [
      { name: "Inter", data: regular, weight: 400, style: "normal" },
      { name: "Inter", data: bold, weight: 700, style: "normal" },
    ],
  });
  return svg;
}

export interface RenderedPng {
  buffer: Buffer;
  width: number;
  height: number;
  theme: PngThemeId;
}

/** Rasterize a reading card to PNG. */
export async function renderCardPng(card: CardData, opts: RenderOptions = {}): Promise<RenderedPng> {
  const themeId = opts.theme && isPngTheme(opts.theme) ? opts.theme : DEFAULT_PNG_THEME;
  const width = opts.width ?? DEFAULT_PNG_WIDTH;
  const height = opts.height ?? DEFAULT_PNG_HEIGHT;
  const svg = await renderCardSvg(card, { theme: themeId, width, height });
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, width, height, theme: themeId };
}
