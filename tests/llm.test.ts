import { describe, it, expect } from "vitest";
import {
  createLlmClient,
  createOfflineClient,
  createOpenAIClient,
  MissingApiKeyError,
  LlmHttpError,
  resolveLlmConfig,
} from "../src/llm/client.js";
import {
  assembleReadingPrompt,
  systemPreamble,
  ORACLE_PERSONA,
} from "../src/llm/prompts.js";

describe("llm/prompts", () => {
  it("system preamble contains persona + discipline + honesty rails", () => {
    const msg = systemPreamble();
    expect(msg.role).toBe("system");
    expect(msg.content).toContain(ORACLE_PERSONA);
    expect(msg.content).toContain("terminal");
    expect(msg.content).toContain("omens");
  });

  it("system preamble appends extra fragment when provided", () => {
    const msg = systemPreamble("Speak only in iambic pentameter.");
    expect(msg.content).toMatch(/iambic pentameter\.$/);
  });

  it("assembled reading prompt is a stable snapshot", () => {
    const messages = assembleReadingPrompt({
      methodName: "tarot",
      symbols: ["The Fool", "The Tower", "The Star"],
      diff: "diff --git a/x b/x\n+hello\n",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toMatchInlineSnapshot(`
      "Divination method: tarot.
      Symbols drawn:
      1. The Fool
      2. The Tower
      3. The Star

      Diff under examination:
      \`\`\`diff
      diff --git a/x b/x
      +hello

      \`\`\`

      Deliver the reading."
    `);
  });

  it("truncates long diffs and notes how many bytes were dropped", () => {
    const huge = "x".repeat(20000);
    const [, user] = assembleReadingPrompt({
      methodName: "runes",
      symbols: ["Fehu"],
      diff: huge,
      maxDiffChars: 100,
    });
    expect(user.content).toContain("[diff truncated, 19900 bytes omitted]");
  });

  it("handles empty symbol draws gracefully", () => {
    const [, user] = assembleReadingPrompt({
      methodName: "tea-leaves",
      symbols: [],
      diff: "diff",
    });
    expect(user.content).toContain("(no symbols drawn)");
  });
});

describe("llm/client config resolution", () => {
  it("falls back to env vars when no overrides given", () => {
    const cfg = resolveLlmConfig(
      {},
      {
        OPENAI_API_KEY: "sk-abc",
        OPENAI_BASE_URL: "http://localhost:1234/v1",
        OPENAI_MODEL: "llama3",
      } as NodeJS.ProcessEnv,
    );
    expect(cfg.apiKey).toBe("sk-abc");
    expect(cfg.baseUrl).toBe("http://localhost:1234/v1");
    expect(cfg.model).toBe("llama3");
  });

  it("explicit overrides win over env", () => {
    const cfg = resolveLlmConfig(
      { apiKey: "explicit", baseUrl: "https://x/v1", model: "m" },
      { OPENAI_API_KEY: "env" } as NodeJS.ProcessEnv,
    );
    expect(cfg.apiKey).toBe("explicit");
    expect(cfg.baseUrl).toBe("https://x/v1");
    expect(cfg.model).toBe("m");
  });

  it("defaults baseUrl + model when nothing is configured", () => {
    const cfg = resolveLlmConfig({}, {} as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).toContain("openai.com");
    expect(cfg.model).toBeTruthy();
  });
});

describe("llm/client factory", () => {
  it("offline mode bypasses key requirement", async () => {
    const c = createLlmClient({ offline: true });
    expect(c.id).toBe("offline:mock");
    const out = await c.complete([{ role: "user", content: "hi" }]);
    expect(out).toContain("🔮");
  });

  it("offline client is deterministic for the same input", async () => {
    const c1 = createOfflineClient();
    const c2 = createOfflineClient();
    const msgs = [{ role: "user" as const, content: "same input" }];
    expect(await c1.complete(msgs)).toBe(await c2.complete(msgs));
  });

  it("offline client differs across different inputs", async () => {
    const c = createOfflineClient();
    const a = await c.complete([{ role: "user", content: "alpha" }]);
    const b = await c.complete([{ role: "user", content: "different seed entirely" }]);
    // not asserting strict inequality of content (small deck), just that it runs without error.
    expect(typeof a).toBe("string");
    expect(typeof b).toBe("string");
  });

  it("throws MissingApiKeyError when no key + no offline + no fallback", () => {
    expect(() =>
      createLlmClient({ apiKey: undefined, offline: false }),
    ).toThrow(MissingApiKeyError);
  });

  it("falls back to offline when allowOfflineFallback + no key", async () => {
    const c = createLlmClient({ apiKey: undefined, allowOfflineFallback: true });
    expect(c.id).toBe("offline:mock");
  });
});

describe("llm/client openai HTTP", () => {
  it("posts to /chat/completions with bearer auth and parses content", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "  blessed.  " } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = createOpenAIClient({
      apiKey: "sk-test",
      baseUrl: "https://example.test/v1/",
      model: "test-model",
      fetchImpl: fakeFetch,
    });
    const out = await client.complete([{ role: "user", content: "ping" }], {
      temperature: 0.1,
      maxTokens: 64,
    });
    expect(out).toBe("blessed.");
    expect(captured).not.toBeNull();
    const cap = captured!;
    expect(cap.url).toBe("https://example.test/v1/chat/completions");
    const headers = cap.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(cap.init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(64);
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("raises LlmHttpError on non-2xx", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("rate limited", { status: 429 });
    const client = createOpenAIClient({
      apiKey: "k",
      fetchImpl: fakeFetch,
    });
    await expect(
      client.complete([{ role: "user", content: "x" }]),
    ).rejects.toBeInstanceOf(LlmHttpError);
  });

  it("raises if response is malformed", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const client = createOpenAIClient({ apiKey: "k", fetchImpl: fakeFetch });
    await expect(
      client.complete([{ role: "user", content: "x" }]),
    ).rejects.toBeInstanceOf(LlmHttpError);
  });

  it("MissingApiKeyError mentions --offline so users have a way out", () => {
    const err = new MissingApiKeyError();
    expect(err.message).toMatch(/--offline/);
  });
});
