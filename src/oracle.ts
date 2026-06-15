export const VERSION = "0.0.1";

/**
 * A small ceremonial greeting from the oracle.
 * Real divination arrives in later milestones.
 */
export function hello(name: string): string {
  const who = name.trim() || "seeker";
  return `🔮 the oracle stirs and acknowledges you, ${who}.`;
}
