import type { DivinationMethod } from "./types.js";
import { tarot } from "./tarot.js";

const METHODS: ReadonlyArray<DivinationMethod> = [tarot];
const BY_ID = new Map(METHODS.map((m) => [m.id, m]));

export function listMethods(): ReadonlyArray<DivinationMethod> {
  return METHODS;
}

export function getMethod(id: string): DivinationMethod | undefined {
  return BY_ID.get(id);
}

export const DEFAULT_METHOD_ID = "tarot";

export type { DivinationMethod, DrawnSymbol } from "./types.js";
