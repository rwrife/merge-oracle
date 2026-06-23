import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  handleRequest,
  runStdioServer,
  TOOL_DEFINITIONS,
  MCP_PROTOCOL_VERSION,
  JSON_RPC_ERROR,
  type JsonRpcRequest,
} from "../src/mcp/server.js";
import type { LoadedDiff } from "../src/sources/types.js";
import type { LlmClient } from "../src/llm/client.js";

const fakeLoad = async (source: string): Promise<LoadedDiff> => ({
  source,
  origin: "file",
  diff: "diff --git a/x b/x\n+hello\n",
});

const fakeClient = (): LlmClient => ({
  id: "offline:mock",
  async complete() {
    return "🔮 mocked verdict";
  },
});

const fakeMake = () => fakeClient();

describe("mcp server — handleRequest", () => {
  it("answers initialize with protocol + server info", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res?.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: "merge-oracle" },
    });
    expect(res?.id).toBe(1);
  });

  it("treats notifications/initialized as a no-op (no response)", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toBeNull();
  });

  it("lists tools including oracle.read and oracle.methods", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["oracle.methods", "oracle.read"]);
    // schema sanity
    const read = TOOL_DEFINITIONS.find((t) => t.name === "oracle.read")!;
    expect(read.inputSchema.required).toContain("source");
  });

  it("returns METHOD_NOT_FOUND for unknown methods", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 3, method: "no.such.method" });
    expect(res?.error?.code).toBe(JSON_RPC_ERROR.METHOD_NOT_FOUND);
  });

  it("rejects tools/call without a name", async () => {
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { arguments: {} },
    });
    expect(res?.error?.code).toBe(JSON_RPC_ERROR.INVALID_PARAMS);
  });

  it("oracle.methods returns the registered methods", async () => {
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "oracle.methods", arguments: {} },
    });
    const structured = (res?.result as { structuredContent: { methods: Array<{ id: string }> } })
      .structuredContent;
    const ids = structured.methods.map((m) => m.id);
    expect(ids).toContain("tarot");
    expect(ids).toContain("i-ching");
  });

  it("oracle.read produces a structured reading via injected deps", async () => {
    const res = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "oracle.read",
          arguments: { source: "fixture.diff", method: "tarot", offline: true, json: true },
        },
      },
      { loadDiff: fakeLoad, createClient: fakeMake as never },
    );
    const result = res?.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { method: string; reading: string; symbols: unknown[] };
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.method).toBe("tarot");
    expect(result.structuredContent.reading).toContain("mocked verdict");
    expect(result.structuredContent.symbols.length).toBeGreaterThan(0);
    expect(result.content[0].type).toBe("text");
  });

  it("oracle.read renders text by default (no json flag)", async () => {
    const res = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "oracle.read",
          arguments: { source: "fixture.diff", method: "runes", offline: true },
        },
      },
      { loadDiff: fakeLoad, createClient: fakeMake as never },
    );
    const result = res?.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("🔮");
    expect(result.content[0].text).toContain("mocked verdict");
  });

  it("oracle.read returns tool-level error for unknown method", async () => {
    const res = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "oracle.read",
          arguments: { source: "fixture.diff", method: "no-such-thing", offline: true },
        },
      },
      { loadDiff: fakeLoad, createClient: fakeMake as never },
    );
    const result = res?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unknown divination method/);
  });

  it("oracle.read rejects missing source argument", async () => {
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "oracle.read", arguments: {} },
    });
    expect(res?.error?.code).toBe(JSON_RPC_ERROR.INTERNAL);
    expect(res?.error?.message).toMatch(/source/);
  });
});

describe("mcp server — stdio loop", () => {
  it("processes line-delimited JSON-RPC and writes responses to stdout", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks: string[] = [];
    stdout.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const done = runStdioServer({ stdin, stdout, stderr });

    const requests: JsonRpcRequest[] = [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
    stdin.end();
    await done;

    const responses = chunks
      .join("")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(responses).toHaveLength(2); // notification produced no response
    expect(responses[0].id).toBe(1);
    expect(responses[0].result.serverInfo.name).toBe("merge-oracle");
    expect(responses[1].id).toBe(2);
    expect(responses[1].result.tools.length).toBeGreaterThanOrEqual(2);
  });

  it("emits a parse error for malformed JSON lines", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const done = runStdioServer({ stdin, stdout });
    stdin.write("not json at all\n");
    stdin.end();
    await done;

    const lines = chunks.join("").split("\n").filter(Boolean);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.error.code).toBe(JSON_RPC_ERROR.PARSE);
  });
});
