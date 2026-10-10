import OpenAI from "openai";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMClient,
  ToolCallRequest,
  ToolChoice,
} from "../../ports/llm-client.js";

export interface OpenRouterOptions {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Thin wrapper over the openai npm package. Any OpenAI-compatible endpoint (OpenRouter,
 * LM Studio, a self-hosted model) works — override `baseURL`. Provider fallback + retries
 * live in the agent loop, so this is a single-call adapter.
 */
export function createOpenRouterLLMClient(opts: OpenRouterOptions): LLMClient {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL ?? DEFAULT_BASE_URL,
    ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
  });

  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: req.model,
        messages: req.messages.map(toOpenAiMessage),
      };
      if (req.tools?.length) body.tools = req.tools;
      if (req.tool_choice) body.tool_choice = toOpenAiToolChoice(req.tool_choice);
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;

      // OpenRouter can return HTTP 200 with an error object and NO `choices` field
      // when the upstream provider hiccups (502/503/504/529 unexpected_error, etc).
      // The OpenAI SDK treats 200 as success and won't retry these, so a single
      // transient blip aborts the whole cycle. Retry transient no-choices in-band;
      // fail fast on client-side errors (4xx). Reading choices[0] without the ?.
      // guard would throw a cryptic "reading '0'".
      const TRANSIENT_CODES = new Set([500, 502, 503, 504, 529]);
      const maxAttempts = 3;
      let lastDetail = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const response = await client.chat.completions.create(body);
        const first = response.choices?.[0];
        if (first) {
          const msg = first.message;
          const toolCalls = mergeToolCallFragments(
            (msg.tool_calls ?? []).flatMap((tc) => {
              if (tc.type !== "function") return [];
              return [{ id: tc.id ?? "", name: tc.function.name ?? "", arguments: tc.function.arguments ?? "" }];
            }),
          );
          return {
            text: msg.content ?? null,
            tool_calls: toolCalls,
            finish_reason: first.finish_reason ?? null,
            model: response.model,
            ...(response.usage
              ? {
                  usage: {
                    prompt_tokens: response.usage.prompt_tokens,
                    completion_tokens: response.usage.completion_tokens,
                    total_tokens: response.usage.total_tokens,
                  },
                }
              : {}),
          };
        }
        const errObj = (response as { error?: { message?: string; code?: string | number } }).error;
        lastDetail = errObj?.message
          ? `provider error${errObj.code != null ? ` (${errObj.code})` : ""}: ${errObj.message}`
          : JSON.stringify(response).slice(0, 300);
        const codeNum = typeof errObj?.code === "number" ? errObj.code : Number(errObj?.code);
        // Unknown code (NaN) → treat as transient and retry; a real 4xx is fail-fast.
        const transient = !Number.isFinite(codeNum) || TRANSIENT_CODES.has(codeNum);
        if (attempt >= maxAttempts || !transient) {
          throw new Error(`LLM returned no choices — ${lastDetail}`);
        }
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
      throw new Error(`LLM returned no choices — ${lastDetail}`);
    },
  };
}

/**
 * Some OpenAI-compatible proxies (BandelAI, 2026-10-05) aggregate a streamed upstream reply
 * without merging the deltas, so one call arrives as N entries: the first carries id + name,
 * the rest have no id/name and hold successive argument chunks. Re-join them; a fragment with
 * neither id nor name continues the previous call. Well-formed responses pass through as-is.
 */
export function mergeToolCallFragments(calls: readonly ToolCallRequest[]): ToolCallRequest[] {
  const merged: ToolCallRequest[] = [];
  for (const c of calls) {
    const last = merged[merged.length - 1];
    if (last && !c.id && !c.name) {
      last.arguments += c.arguments;
      continue;
    }
    merged.push({ ...c });
  }
  return merged.filter((c) => c.name);
}

type OpenAiMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toOpenAiMessage(m: ChatMessage): OpenAiMessage {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "tool":
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.tool_call_id ?? "",
      };
    case "assistant": {
      const base: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: m.content,
      };
      if (m.tool_calls?.length) {
        base.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return base;
    }
  }
}

function toOpenAiToolChoice(c: ToolChoice): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption {
  if (c === "auto" || c === "required" || c === "none") return c;
  return { type: "function", function: { name: c.name } };
}
