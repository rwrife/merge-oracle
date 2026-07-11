import { describe, it, expect } from "vitest";
import {
  diffStats,
  parseDuelReply,
  runDuel,
  runDuelWithOfflineFallback,
  synthesizeOfflineVerdict,
  duelJsonBlob,
  renderDuelCard,
  DuelInputError,
  type DuelContender,
} from "../src/duel.js";
import { getMethod } from "../src/methods/_registry.js";
import { resolvePersona, DEFAULT_PERSONA_ID } from "../src/personas/_registry.js";
import { createOfflineClient } from "../src/llm/client.js";
import type { LoadedDiff } from "../src/sources/types.js";
import type { LlmClient } from "../src/llm/index.js";

const DIFF_A = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@
-const x = 1;
+const x = 2;
+const y = 3;
`;

const DIFF_B = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@
-function old() { return 0; }
+function next() { return 1; }
+function extra() { return 2; }
+function more() { return 3; }
+function evenMore() { return 4; }
diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@
-const z = 0;
+const z = 42;
`;

function loaderFor(map: Record<string, string>) {
  return async (locator: string): Promise<LoadedDiff> => ({
    source: "file",
    origin: locator,
    diff: map[locator] ?? "",
  });
}

describe("duel/diffStats", () => {
  it("counts files, additions, and deletions", () => {
    const s = diffStats(DIFF_A);
    expect(s.files).toBe(1);
    expect(s.additions).toBe(2);
    expect(s.deletions).toBe(1);
  });

  it("handles multi-file diffs", () => {
    const s = diffStats(DIFF_B);
    expect(s.files).toBe(2);
    expect(s.additions).toBeGreaterThan(s.deletions);
  });
});

describe("duel/parseDuelReply", () => {
  it("extracts a well-formed JSON verdict", () => {
    const reply = `Prose narrative here.\n{"verdict":"favor-a","confidence":"high","rationale":"cleaner","carryForward":"trim B"}`;
    const { judgement, verdict } = parseDuelReply(reply);
    expect(judgement).toBe("Prose narrative here.");
    expect(verdict.verdict).toBe("favor-a");
    expect(verdict.confidence).toBe("high");
    expect(verdict.carryForward).toBe("trim B");
  });

  it("falls back to favor-neither on unparseable input", () => {
    const { verdict } = parseDuelReply("no json here, just prose");
    expect(verdict.verdict).toBe("favor-neither");
    expect(verdict.confidence).toBe("low");
    expect(verdict.carryForward).toBeNull();
  });

  it("nulls carryForward when verdict is favor-neither", () => {
    const { verdict } = parseDuelReply(
      `judge\n{"verdict":"favor-neither","confidence":"medium","rationale":"tie","carryForward":"ignored"}`,
    );
    expect(verdict.carryForward).toBeNull();
  });

  it("coerces unknown verdict values to favor-neither", () => {
    const { verdict } = parseDuelReply(
      `x\n{"verdict":"maybe","confidence":"low","rationale":"?"}`,
    );
    expect(verdict.verdict).toBe("favor-neither");
  });
});

describe("duel/synthesizeOfflineVerdict", () => {
  const mk = (label: "A" | "B", files: number, add: number, del: number): DuelContender => ({
    label,
    loaded: { source: "file", origin: `${label}.diff`, diff: "" },
    symbols: [],
    reading: "",
    stats: { files, additions: add, deletions: del },
  });

  it("favors the side with more signal", () => {
    const a = mk("A", 1, 2, 1);
    const b = mk("B", 3, 20, 5);
    const { verdict } = synthesizeOfflineVerdict(a, b);
    expect(verdict.verdict).toBe("favor-b");
  });

  it("returns favor-neither on identical scores", () => {
    const a = mk("A", 1, 5, 5);
    const b = mk("B", 1, 5, 5);
    const { verdict } = synthesizeOfflineVerdict(a, b);
    expect(verdict.verdict).toBe("favor-neither");
  });
});

describe("duel/runDuel", () => {
  const method = getMethod("tarot")!;
  const persona = resolvePersona(DEFAULT_PERSONA_ID)!;

  it("refuses stdin sources", async () => {
    const client = createOfflineClient();
    await expect(
      runDuel({
        sourceA: "-",
        sourceB: "b.diff",
        method,
        persona,
        client,
        load: loaderFor({ "b.diff": DIFF_B }),
      }),
    ).rejects.toBeInstanceOf(DuelInputError);
  });

  it("refuses identical diffs with a wry error", async () => {
    const client = createOfflineClient();
    await expect(
      runDuel({
        sourceA: "a.diff",
        sourceB: "copy.diff",
        method,
        persona,
        client,
        load: loaderFor({ "a.diff": DIFF_A, "copy.diff": DIFF_A }),
      }),
    ).rejects.toThrow(/reflection/);
  });

  it("produces a deterministic offline duel over two distinct diffs", async () => {
    const client = createOfflineClient();
    const args = {
      sourceA: "a.diff",
      sourceB: "b.diff",
      method,
      persona,
      client,
      load: loaderFor({ "a.diff": DIFF_A, "b.diff": DIFF_B }),
    };
    const one = await runDuelWithOfflineFallback(args);
    const two = await runDuelWithOfflineFallback({ ...args, client: createOfflineClient() });
    expect(one.verdict).toEqual(two.verdict);
    expect(one.a.symbols.length).toBeGreaterThan(0);
    expect(one.b.symbols.length).toBeGreaterThan(0);
    expect(one.channel).toBe("offline:mock");
    // Contender B has more signal, so the offline fallback should favor B.
    expect(one.verdict.verdict).toBe("favor-b");
  });

  it("honors a scripted LLM verdict when the reply is parseable", async () => {
    const scripted: LlmClient = {
      id: "scripted:test",
      async complete(messages) {
        // First two calls are per-side readings; the third is the duel judgement.
        // We return a stable payload for each so the parser has something to chew on.
        const isDuel = messages.some((m) =>
          m.content.includes("judging a DUEL"),
        );
        if (isDuel) {
          return `Contender A shows tighter intent; B sprawls.\n{"verdict":"favor-a","confidence":"medium","rationale":"A is more focused","carryForward":"borrow B's variety"}`;
        }
        return "a per-side reading in ritual cadence.";
      },
    };
    const result = await runDuel({
      sourceA: "a.diff",
      sourceB: "b.diff",
      method,
      persona,
      client: scripted,
      load: loaderFor({ "a.diff": DIFF_A, "b.diff": DIFF_B }),
    });
    expect(result.verdict.verdict).toBe("favor-a");
    expect(result.verdict.confidence).toBe("medium");
    expect(result.verdict.carryForward).toBe("borrow B's variety");
    expect(result.judgement).toContain("tighter intent");
  });

  it("renders text + JSON forms that agree on the verdict", async () => {
    const client = createOfflineClient();
    const result = await runDuelWithOfflineFallback({
      sourceA: "a.diff",
      sourceB: "b.diff",
      method,
      persona,
      client,
      load: loaderFor({ "a.diff": DIFF_A, "b.diff": DIFF_B }),
    });
    const text = renderDuelCard(result);
    expect(text).toContain("The contenders");
    expect(text).toContain("Verdict:");
    const json = duelJsonBlob(result) as { duel: { verdict: string } };
    expect(json.duel.verdict).toBe(result.verdict.verdict);
  });
});
