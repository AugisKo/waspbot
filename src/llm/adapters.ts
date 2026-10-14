// One shape for every hosted LLM the wasps can ask: Gemini, Claude (Anthropic) and OpenAI. Each adapter knows how to
// build a JSON-only request for its API, where to send it, which headers carry the key, and how to read the text and
// token usage back. The chooser (jev.ts) and the knowledge layer (knowledge/digest.ts, news/websearch.ts) share them,
// so cost caps, timeouts and redaction work the same way for every provider.
//
// Keys travel only in headers, never in URLs or prompts.

export type LlmProvider = "gemini" | "claude" | "openai";

export interface LlmRequest {
  /** The whole prompt (instructions + data). */
  prompt: string;
  /** Optional system instructions, sent separately where the API supports it. */
  system?: string;
  maxOutputTokens: number;
  temperature?: number;
  /** When set, ask the API to answer in JSON that matches this (JSON-Schema-ish) object. */
  jsonSchema?: Record<string, unknown>;
  /** Let the model search the web while answering (news/websearch.ts). Not every model supports it. */
  webSearch?: boolean;
  /** Gemini only: thinkingConfig.thinkingLevel. */
  thinkingLevel?: string;
}

export interface LlmResponse {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Web searches the provider billed for this call (Claude reports it; others: null). */
  webSearches: number | null;
  finishReason: string | null;
}

export interface LlmAdapter {
  provider: LlmProvider;
  url(model: string): string;
  headers(apiKey: string): Record<string, string>;
  body(model: string, req: LlmRequest): unknown;
  parse(data: unknown): LlmResponse;
}

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

/** JSON-Schema (lower-case types) to Gemini's responseSchema dialect (upper-case types). */
function toGeminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "additionalProperties") continue;
    out[k] = k === "type" && typeof v === "string" ? v.toUpperCase() : toGeminiSchema(v);
  }
  return out;
}

const gemini: LlmAdapter = {
  provider: "gemini",
  url: (model) => `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`,
  headers: (key) => ({ "content-type": "application/json", "x-goog-api-key": key }),
  body: (_model, r) => ({
    ...(r.system ? { systemInstruction: { parts: [{ text: r.system }] } } : {}),
    contents: [{ role: "user", parts: [{ text: r.prompt }] }],
    ...(r.webSearch ? { tools: [{ google_search: {} }] } : {}),
    generationConfig: {
      temperature: r.temperature ?? 0.1,
      maxOutputTokens: r.maxOutputTokens,
      // Gemini refuses a response schema together with the search tool: the prompt asks for JSON instead.
      ...(r.jsonSchema && !r.webSearch ? { responseMimeType: "application/json", responseSchema: toGeminiSchema(r.jsonSchema) } : {}),
      ...(r.thinkingLevel ? { thinkingConfig: { thinkingLevel: r.thinkingLevel } } : {}),
    },
  }),
  parse: (data) => {
    const d = data as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    };
    const u = d.usageMetadata;
    const out = u && (u.candidatesTokenCount !== undefined || u.thoughtsTokenCount !== undefined) ? (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) : null;
    return {
      text: (d.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join(""),
      inputTokens: u?.promptTokenCount ?? null,
      outputTokens: out,
      webSearches: null,
      finishReason: d.candidates?.[0]?.finishReason ?? null,
    };
  },
};

const claude: LlmAdapter = {
  provider: "claude",
  url: () => ANTHROPIC_URL,
  headers: (key) => ({ "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }),
  body: (model, r) => ({
    model,
    max_tokens: r.maxOutputTokens,
    temperature: r.temperature ?? 0.1,
    ...(r.system ? { system: r.system } : {}),
    messages: [{ role: "user", content: r.jsonSchema ? `${r.prompt}\n\nAnswer with a single JSON object only, no prose, matching this schema: ${JSON.stringify(r.jsonSchema)}` : r.prompt }],
    ...(r.webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] } : {}),
  }),
  parse: (data) => {
    const d = data as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number; server_tool_use?: { web_search_requests?: number } };
      stop_reason?: string;
    };
    // With web search on, the answer is the last text block (earlier blocks narrate the searches).
    const texts = (d.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "");
    return {
      text: extractJsonish(texts.length ? texts[texts.length - 1]! : ""),
      inputTokens: d.usage?.input_tokens ?? null,
      outputTokens: d.usage?.output_tokens ?? null,
      webSearches: d.usage?.server_tool_use?.web_search_requests ?? null,
      finishReason: d.stop_reason ?? null,
    };
  },
};

const openai: LlmAdapter = {
  provider: "openai",
  // Web search lives on the Responses API; plain JSON choices use Chat Completions (cheapest, widest model support).
  url: () => OPENAI_CHAT_URL,
  headers: (key) => ({ "content-type": "application/json", authorization: `Bearer ${key}` }),
  body: (model, r) => ({
    model,
    max_completion_tokens: r.maxOutputTokens,
    messages: [...(r.system ? [{ role: "system", content: r.system }] : []), { role: "user", content: r.prompt }],
    ...(r.jsonSchema ? { response_format: { type: "json_schema", json_schema: { name: "answer", schema: r.jsonSchema } } } : {}),
  }),
  parse: (data) => {
    const d = data as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: d.choices?.[0]?.message?.content ?? "",
      inputTokens: d.usage?.prompt_tokens ?? null,
      outputTokens: d.usage?.completion_tokens ?? null,
      webSearches: null,
      finishReason: d.choices?.[0]?.finish_reason ?? null,
    };
  },
};

/** OpenAI with web search: the Responses API and its web_search tool. */
export const openaiResponses: LlmAdapter = {
  provider: "openai",
  url: () => OPENAI_RESPONSES_URL,
  headers: openai.headers,
  body: (model, r) => ({
    model,
    max_output_tokens: r.maxOutputTokens,
    ...(r.system ? { instructions: r.system } : {}),
    input: r.jsonSchema ? `${r.prompt}\n\nAnswer with a single JSON object only, matching this schema: ${JSON.stringify(r.jsonSchema)}` : r.prompt,
    ...(r.webSearch ? { tools: [{ type: "web_search" }] } : {}),
  }),
  parse: (data) => {
    const d = data as {
      output_text?: string;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      status?: string;
    };
    const text =
      d.output_text ??
      (d.output ?? [])
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text ?? "")
        .join("");
    return { text: extractJsonish(text), inputTokens: d.usage?.input_tokens ?? null, outputTokens: d.usage?.output_tokens ?? null, webSearches: null, finishReason: d.status ?? null };
  },
};

export const ADAPTERS: Record<LlmProvider, LlmAdapter> = { gemini, claude, openai };

/** The adapter to use for a call: OpenAI switches to the Responses API when the call wants web search. */
export function adapterFor(provider: LlmProvider, webSearch = false): LlmAdapter {
  return provider === "openai" && webSearch ? openaiResponses : ADAPTERS[provider];
}

/**
 * Models sometimes wrap JSON in prose or a ```json fence. Return the outermost {...} or [...] span when the text is not
 * already pure JSON; otherwise the text unchanged. Strict parsing (parseChoice) still decides whether it is valid.
 */
export function extractJsonish(text: string): string {
  const t = text.trim();
  if (!t || t.startsWith("{") || t.startsWith("[")) return t;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) return fence[1]!.trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

/**
 * Guaranteed upper bound on the input tokens of a request body: one token per UTF-8 byte plus framing. No tokenizer
 * yields more tokens than bytes; character ratios such as "4 characters per token" are only averages.
 */
export const inputTokenBound = (body: string): number => Buffer.byteLength(body, "utf8") + 64;

export interface LlmPrices {
  /** USD per million input tokens. */
  inPerMTok: number;
  /** USD per million output tokens (thinking included). */
  outPerMTok: number;
  /** USD per web search (Claude bills per search; others fold it into tokens or a per-call fee). */
  perSearch?: number;
}

/** Worst case a call can cost before it is sent: the input bound plus the full output budget (plus searches). */
export function worstCaseUsd(body: string, maxOut: number, p: LlmPrices, maxSearches = 0): number {
  return (inputTokenBound(body) * p.inPerMTok + maxOut * p.outPerMTok) / 1e6 + maxSearches * (p.perSearch ?? 0);
}

/** What a finished call is charged: real usage where reported, the worst case for anything unknown. */
export function chargedUsd(r: LlmResponse, body: string, maxOut: number, p: LlmPrices, maxSearches = 0): number {
  const inTok = r.inputTokens ?? inputTokenBound(body);
  const outTok = r.outputTokens ?? maxOut;
  const searches = r.webSearches ?? maxSearches;
  return (inTok * p.inPerMTok + outTok * p.outPerMTok) / 1e6 + searches * (p.perSearch ?? 0);
}

export interface CallOpts {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One call. Throws LlmHttpError on a non-2xx answer and the fetch error (timeout, network) otherwise. */
export async function callLlm(o: CallOpts, req: LlmRequest): Promise<{ res: LlmResponse; body: string }> {
  const a = adapterFor(o.provider, req.webSearch);
  const body = JSON.stringify(a.body(o.model, req));
  const doFetch = o.fetchFn ?? fetch;
  const res = await doFetch(a.url(o.model), { method: "POST", headers: a.headers(o.apiKey), signal: AbortSignal.timeout(o.timeoutMs), body });
  if (!res.ok) throw new LlmHttpError(res.status, `${o.provider} HTTP ${res.status}`);
  return { res: a.parse(await res.json()), body };
}

/** Request body for a call, without sending it (the cap check prices it before the call goes out). */
export function requestBody(provider: LlmProvider, model: string, req: LlmRequest): string {
  return JSON.stringify(adapterFor(provider, req.webSearch).body(model, req));
}
