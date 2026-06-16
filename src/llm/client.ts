import type { ChatMessage } from "./prompts.js";

export interface LlmCompleteOptions {
  /** Override the configured model for this single call. */
  model?: string;
  /** Sampling temperature. Defaults to 0.8 for mystical flair. */
  temperature?: number;
  /** Hard cap on output tokens. */
  maxTokens?: number;
  /** Abort signal for cancellation / timeouts. */
  signal?: AbortSignal;
}

export interface LlmClient {
  readonly id: string;
  complete(messages: ChatMessage[], opts?: LlmCompleteOptions): Promise<string>;
}

export interface LlmConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** When true, ignore env/config and always use the offline mock. */
  offline?: boolean;
  /** Optional fetch override (mainly for tests). */
  fetchImpl?: typeof fetch;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "the oracle needs a key to scry: set OPENAI_API_KEY (or pass --offline for a mock reading)",
    );
    this.name = "MissingApiKeyError";
  }
}

export class LlmHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`LLM endpoint returned ${status}: ${body.slice(0, 200)}`);
    this.name = "LlmHttpError";
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * Resolve config from explicit overrides + process.env.
 * Explicit fields win; otherwise we fall back to standard OpenAI env vars.
 */
export function resolveLlmConfig(
  overrides: LlmConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): Required<Pick<LlmConfig, "baseUrl" | "model">> & LlmConfig {
  return {
    apiKey: overrides.apiKey ?? env.OPENAI_API_KEY,
    baseUrl: overrides.baseUrl ?? env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    model: overrides.model ?? env.OPENAI_MODEL ?? DEFAULT_MODEL,
    offline: overrides.offline ?? false,
    fetchImpl: overrides.fetchImpl,
  };
}

/**
 * Tiny OpenAI-compatible chat client. Uses global fetch (Node 18+).
 * Works against api.openai.com, LM Studio, Ollama (`/v1`), vLLM, etc.
 */
export function createOpenAIClient(config: LlmConfig = {}): LlmClient {
  const resolved = resolveLlmConfig(config);
  if (!resolved.apiKey) throw new MissingApiKeyError();
  const doFetch = resolved.fetchImpl ?? fetch;
  const url = `${resolved.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    id: `openai:${resolved.model}`,
    async complete(messages, opts = {}) {
      const body = {
        model: opts.model ?? resolved.model,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens,
      };
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (!res.ok) {
        const text = await safeText(res);
        throw new LlmHttpError(res.status, text);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new LlmHttpError(200, "missing choices[0].message.content");
      }
      return content.trim();
    },
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

/** Canned mystical drivel for `--offline` mode and tests. */
const OFFLINE_LINES = [
  "🔮 the cards lay themselves down in candlelight…",
  "Past: the base branch carries old grudges; a forgotten TODO whispers.",
  "Present: your diff hums with intent — neither blessed nor cursed, simply willed.",
  "Future: CI will smile, but a reviewer's eyebrow shall arch at line breaks unseen.",
  "Verdict: the oracle nods. Proceed, but light a candle for the type-checker.",
];

/**
 * Deterministic offline client. Produces the same reading for the same input,
 * so snapshot tests stay stable.
 */
export function createOfflineClient(lines: string[] = OFFLINE_LINES): LlmClient {
  return {
    id: "offline:mock",
    async complete(messages) {
      const seed = messages.map((m) => `${m.role}:${m.content}`).join("\n");
      const hash = djb2(seed);
      const rotated = [...lines.slice(hash % lines.length), ...lines.slice(0, hash % lines.length)];
      return rotated.join("\n");
    },
  };
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * High-level factory: pick offline mock when requested or no key is configured
 * and `allowOfflineFallback` is true. Throws `MissingApiKeyError` otherwise.
 */
export function createLlmClient(
  config: LlmConfig & { allowOfflineFallback?: boolean } = {},
): LlmClient {
  if (config.offline) return createOfflineClient();
  const resolved = resolveLlmConfig(config);
  if (!resolved.apiKey) {
    if (config.allowOfflineFallback) return createOfflineClient();
    throw new MissingApiKeyError();
  }
  return createOpenAIClient(config);
}
