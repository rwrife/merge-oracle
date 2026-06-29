import type { DrawnSymbol } from "../methods/types.js";
import type { Persona } from "./types.js";

export const bardPersona: Persona = {
  id: "bard",
  name: "the Bard",
  describe() {
    return "delivers every reading as rhyming couplets. Insufferable, in a fun way.";
  },
  systemPrompt: [
    "Speak as a wandering bard. Render the entire reading in rhyming couplets (AA BB CC …).",
    "Keep lines short — eight to twelve syllables. Reference each symbol by name.",
    "End with a final couplet that delivers the merge prophecy.",
  ].join(" "),
  offlineLines(symbols: DrawnSymbol[]) {
    const a = symbols[0]?.name ?? "a sign unknown";
    const b = symbols[1]?.name ?? "a stranger's tone";
    const c = symbols[2]?.name ?? "a fate alone";
    return [
      "🎻 *strums a lute, clears throat*",
      `Behold ${a}, where past doth weep,`,
      "of bugs once buried, now astir from sleep;",
      `then ${b}, the present's restless tide,`,
      "your diff doth bloom, with shadows close beside;",
      `and last, ${c}, the merge's prophecy,`,
      "a green-checked CI — or sweet catastrophe.",
    ];
  },
};
