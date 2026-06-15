import type { DiffLoader, LoadedDiff } from "./types.js";

export interface StdinLike {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export async function readAll(stream: StdinLike): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
    });
    stream.on("end", () => resolvePromise(buf));
    stream.on("error", (err: Error) => reject(err));
  });
}

export function createStdinLoader(stream: StdinLike = process.stdin): DiffLoader {
  return {
    id: "stdin",
    matches(locator: string): boolean {
      return locator === "-" || locator === "";
    },
    async load(locator: string): Promise<LoadedDiff> {
      const diff = await readAll(stream);
      return {
        source: "stdin",
        origin: locator || "-",
        diff,
      };
    },
  };
}

export const stdinLoader = createStdinLoader();
