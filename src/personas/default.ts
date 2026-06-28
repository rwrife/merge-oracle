import type { DrawnSymbol } from "../methods/types.js";
import type { Persona } from "./types.js";

/**
 * The original merge-oracle voice — preserved as the default so omitting
 * `--persona` is a strict no-op compared to pre-persona-packs behaviour.
 */
export const defaultPersona: Persona = {
  id: "default",
  name: "the Oracle (default)",
  describe() {
    return "the canonical merge-oracle voice — vaguely-mystic, ritual cadence, neutral register.";
  },
  systemPrompt: "",
  offlineLines() {
    return [
      "🔮 the cards lay themselves down in candlelight…",
      "Past: the base branch carries old grudges; a forgotten TODO whispers.",
      "Present: your diff hums with intent — neither blessed nor cursed, simply willed.",
      "Future: CI will smile, but a reviewer's eyebrow shall arch at line breaks unseen.",
      "Verdict: the oracle nods. Proceed, but light a candle for the type-checker.",
    ];
  },
};
