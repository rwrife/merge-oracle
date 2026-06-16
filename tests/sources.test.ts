import { describe, it, expect } from "vitest";
import { pickLoader, loadDiff, defaultLoaders } from "../src/sources/index.js";
import { fileLoader } from "../src/sources/file.js";
import { githubLoader, parsePrUrl, createGithubLoader } from "../src/sources/github.js";
import { createStdinLoader, readAll } from "../src/sources/stdin.js";
import { Readable } from "node:stream";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "..", "test", "fixtures");

describe("sources/file", () => {
  it("matches plain paths but not URLs or stdin", () => {
    expect(fileLoader.matches("foo.diff")).toBe(true);
    expect(fileLoader.matches("/abs/path.patch")).toBe(true);
    expect(fileLoader.matches("https://example.com/x")).toBe(false);
    expect(fileLoader.matches("-")).toBe(false);
    expect(fileLoader.matches("")).toBe(false);
  });

  it("loads a fixture diff from disk", async () => {
    const path = resolve(FIXTURE_DIR, "simple.diff");
    const out = await fileLoader.load(path);
    expect(out.source).toBe("file");
    expect(out.origin).toBe(path);
    expect(out.diff).toContain("diff --git a/src/oracle.ts");
    expect(out.meta?.looksLikeDiff).toBe(true);
    expect(typeof out.meta?.bytes).toBe("number");
  });

  it("throws on missing file", async () => {
    await expect(fileLoader.load("/no/such/file.diff")).rejects.toThrow();
  });
});

describe("sources/github", () => {
  it("parses PR URLs", () => {
    expect(parsePrUrl("https://github.com/rwrife/merge-oracle/pull/42")).toEqual({
      owner: "rwrife",
      repo: "merge-oracle",
      number: 42,
    });
    expect(parsePrUrl("https://github.com/a/b/pull/7/files")).toEqual({
      owner: "a",
      repo: "b",
      number: 7,
    });
    expect(parsePrUrl("https://example.com/a/b/pull/1")).toBeNull();
    expect(parsePrUrl("./local/file.diff")).toBeNull();
  });

  it("matches only PR URLs", () => {
    expect(githubLoader.matches("https://github.com/o/r/pull/1")).toBe(true);
    expect(githubLoader.matches("foo.diff")).toBe(false);
  });

  it("invokes gh and returns parsed metadata + diff", async () => {
    const calls: string[][] = [];
    const fakeGh = async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") {
        return {
          stdout: JSON.stringify({ title: "fake PR", state: "OPEN" }),
          stderr: "",
        };
      }
      if (args[1] === "diff") {
        return { stdout: "diff --git a/x b/x\n", stderr: "" };
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const loader = createGithubLoader(fakeGh);
    const out = await loader.load("https://github.com/o/r/pull/9");
    expect(out.source).toBe("github");
    expect(out.diff).toContain("diff --git");
    expect((out.meta as { title: string }).title).toBe("fake PR");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("view");
    expect(calls[1]).toContain("diff");
  });
});

describe("sources/stdin", () => {
  it("matches '-' and empty string", () => {
    const loader = createStdinLoader();
    expect(loader.matches("-")).toBe(true);
    expect(loader.matches("")).toBe(true);
    expect(loader.matches("file.diff")).toBe(false);
  });

  it("readAll concatenates chunks", async () => {
    const stream = Readable.from(["hello ", "world"]);
    const out = await readAll(stream as unknown as Parameters<typeof readAll>[0]);
    expect(out).toBe("hello world");
  });

  it("loads piped diff content", async () => {
    const stream = Readable.from(["diff --git a/x b/x\n", "+hello\n"]);
    const loader = createStdinLoader(stream as unknown as Parameters<typeof createStdinLoader>[0]);
    const out = await loader.load("-");
    expect(out.source).toBe("stdin");
    expect(out.origin).toBe("-");
    expect(out.diff).toContain("+hello");
  });
});

describe("sources/index dispatch", () => {
  it("picks the right loader for each shape", () => {
    expect(pickLoader("-").id).toBe("stdin");
    expect(pickLoader("https://github.com/o/r/pull/3").id).toBe("github");
    expect(pickLoader("./some/path.diff").id).toBe("file");
  });

  it("loadDiff routes file paths", async () => {
    const out = await loadDiff(resolve(FIXTURE_DIR, "multi-file.diff"));
    expect(out.source).toBe("file");
    expect(out.diff).toContain("src/extra.ts");
  });

  it("throws when nothing matches", () => {
    // Empty locator falls through stdin's matcher, so use a custom loader set.
    expect(() => pickLoader("anything", [])).toThrow(/no loader matched/);
    // Sanity: defaults always match something for non-empty strings.
    expect(defaultLoaders.length).toBeGreaterThan(0);
  });
});
