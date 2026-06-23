import { loadDiff } from "../sources/index.js";
import { createLlmClient, MissingApiKeyError } from "../llm/index.js";
import { DEFAULT_METHOD_ID, getMethod, listMethods } from "../methods/_registry.js";
import { VERSION } from "../oracle.js";

/**
 * Minimal stdio MCP (Model Context Protocol) server.
 *
 * Implements just enough of the JSON-RPC 2.0 surface to be useful to Claude
 * Desktop / Cursor / Codex MCP clients:
 *   - initialize
 *   - tools/list
 *   - tools/call
 *   - notifications/initialized (no-op)
 *   - ping
 *
 * Tools exposed:
 *   - oracle.read    — divine a PR/diff using a chosen method
 *   - oracle.methods — list available divination methods
 *
 * Wire format: line-delimited JSON over stdin/stdout. (LSP-style framing
 * with Content-Length headers is not used; the inspector and most MCP SDK
 * stdio transports accept the simpler newline-delimited variant.)
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "merge-oracle";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const JSON_RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

export interface ReadToolArgs {
  source: string;
  method?: string;
  offline?: boolean;
  json?: boolean;
}

const READ_TOOL_SCHEMA = {
  type: "object",
  properties: {
    source: {
      type: "string",
      description:
        "GitHub PR URL, local path to a .diff/.patch file, or '-' to read from stdin",
    },
    method: {
      type: "string",
      description:
        "Divination method id (e.g. tarot, runes, tea-leaves, i-ching). Defaults to tarot.",
    },
    offline: {
      type: "boolean",
      description:
        "When true, skip the LLM and return canned mystical drivel. Useful for demos and tests.",
      default: false,
    },
    json: {
      type: "boolean",
      description:
        "When true, return structured JSON (source, method, symbols, reading). Otherwise return rendered text.",
      default: false,
    },
  },
  required: ["source"],
  additionalProperties: false,
} as const;

const METHODS_TOOL_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const TOOL_DEFINITIONS = [
  {
    name: "oracle.read",
    description:
      "Divine the fate of a pull request or diff via a chosen method (tarot, runes, tea-leaves, i-ching). Returns a mystical reading.",
    inputSchema: READ_TOOL_SCHEMA,
  },
  {
    name: "oracle.methods",
    description: "List available divination methods.",
    inputSchema: METHODS_TOOL_SCHEMA,
  },
] as const;

export interface McpHandlerOptions {
  /** Override the LLM client factory (mainly for tests). */
  createClient?: typeof createLlmClient;
  /** Override the diff loader (mainly for tests). */
  loadDiff?: typeof loadDiff;
}

/**
 * Dispatch a single parsed JSON-RPC request. Notifications (no `id`) return
 * `null` so callers know not to write a response.
 */
export async function handleRequest(
  req: JsonRpcRequest,
  opts: McpHandlerOptions = {},
): Promise<JsonRpcResponse | null> {
  const isNotification = req.id === undefined;
  const id: JsonRpcId = isNotification ? null : (req.id as JsonRpcId);

  try {
    switch (req.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: VERSION },
        });

      case "initialized":
      case "notifications/initialized":
      case "notifications/cancelled":
        return null; // notifications — no response

      case "ping":
        return ok(id, {});

      case "tools/list":
        return ok(id, { tools: TOOL_DEFINITIONS });

      case "tools/call": {
        const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
        if (typeof params.name !== "string") {
          return err(id, JSON_RPC_ERROR.INVALID_PARAMS, "tools/call requires a 'name'");
        }
        const result = await callTool(params.name, params.arguments ?? {}, opts);
        if (isNotification) return null;
        return ok(id, result);
      }

      default:
        if (isNotification) return null;
        return err(id, JSON_RPC_ERROR.METHOD_NOT_FOUND, `unknown method: ${req.method}`);
    }
  } catch (e) {
    if (isNotification) return null;
    const message = e instanceof Error ? e.message : String(e);
    return err(id, JSON_RPC_ERROR.INTERNAL, message);
  }
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

async function callTool(
  name: string,
  rawArgs: unknown,
  opts: McpHandlerOptions,
): Promise<ToolResult> {
  if (name === "oracle.methods") {
    const methods = listMethods().map((m) => ({
      id: m.id,
      name: m.name,
      description: m.describe(),
      default: m.id === DEFAULT_METHOD_ID,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ default: DEFAULT_METHOD_ID, methods }, null, 2) }],
      structuredContent: { default: DEFAULT_METHOD_ID, methods },
    };
  }

  if (name === "oracle.read") {
    const args = validateReadArgs(rawArgs);
    const method = getMethod(args.method ?? DEFAULT_METHOD_ID);
    if (!method) {
      return toolError(
        `unknown divination method: ${args.method}. try one of: ${listMethods().map((m) => m.id).join(", ")}`,
      );
    }
    const load = opts.loadDiff ?? loadDiff;
    const make = opts.createClient ?? createLlmClient;
    const loaded = await load(args.source);
    const symbols = method.draw(loaded.diff);
    let client;
    try {
      client = make({ offline: args.offline });
    } catch (e) {
      if (e instanceof MissingApiKeyError) {
        return toolError(e.message);
      }
      throw e;
    }
    const reading = await client.complete(method.readingPrompt(symbols, loaded.diff));
    const structured = {
      source: loaded.source,
      origin: loaded.origin,
      method: method.id,
      channel: client.id,
      symbols,
      reading,
    };
    if (args.json) {
      const text = JSON.stringify(structured, null, 2);
      return { content: [{ type: "text", text }], structuredContent: structured };
    }
    const art = method.render(symbols);
    const text =
      `🔮 ${method.name}\n` +
      `   source: ${loaded.source} (${loaded.origin}, ${loaded.diff.length} bytes)\n` +
      `   channel: ${client.id}\n\n${art}\n\n${reading}`;
    return { content: [{ type: "text", text }], structuredContent: structured };
  }

  return toolError(`unknown tool: ${name}`);
}

function validateReadArgs(raw: unknown): ReadToolArgs {
  if (!raw || typeof raw !== "object") {
    throw new Error("oracle.read requires an arguments object with 'source'");
  }
  const a = raw as Record<string, unknown>;
  if (typeof a.source !== "string" || a.source.length === 0) {
    throw new Error("oracle.read requires a string 'source' argument");
  }
  const out: ReadToolArgs = { source: a.source };
  if (a.method !== undefined) {
    if (typeof a.method !== "string") throw new Error("'method' must be a string");
    out.method = a.method;
  }
  if (a.offline !== undefined) {
    if (typeof a.offline !== "boolean") throw new Error("'offline' must be a boolean");
    out.offline = a.offline;
  }
  if (a.json !== undefined) {
    if (typeof a.json !== "boolean") throw new Error("'json' must be a boolean");
    out.json = a.json;
  }
  return out;
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export interface StdioServerOptions extends McpHandlerOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/**
 * Run an MCP server over line-delimited JSON on stdio. Resolves when stdin
 * closes (typically when the client disconnects).
 */
export function runStdioServer(opts: StdioServerOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  return new Promise<void>((resolve) => {
    let buffer = "";

    const write = (msg: JsonRpcResponse) => {
      stdout.write(JSON.stringify(msg) + "\n");
    };

    const handleLine = async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        write({
          jsonrpc: "2.0",
          id: null,
          error: { code: JSON_RPC_ERROR.PARSE, message: "invalid JSON" },
        });
        return;
      }
      if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
        write({
          jsonrpc: "2.0",
          id: (req && (req.id as JsonRpcId)) ?? null,
          error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "invalid JSON-RPC request" },
        });
        return;
      }
      try {
        const res = await handleRequest(req, opts);
        if (res) write(res);
      } catch (e) {
        stderr.write(`mcp handler error: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    };

    stdin.setEncoding?.("utf8");
    stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        void handleLine(line);
      }
    });
    stdin.on("end", () => {
      if (buffer.trim()) void handleLine(buffer);
      resolve();
    });
    stdin.on("close", () => resolve());
  });
}
