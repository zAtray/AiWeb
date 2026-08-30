import {
  buildRagMessages,
  buildRefinementMessages,
  type ConversationMessage,
  type ChatMessage,
} from "./rag-prompts.js";
import type { PackedEvidence, QueryType } from "./types.js";

export interface LLMRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface LLMProvider {
  chat(request: LLMRequest): Promise<LLMResponse>;
}

interface ChatCompletionPayload {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: unknown };
}

export class LLMProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "configuration"
      | "authentication"
      | "rate_limit"
      | "upstream"
      | "timeout"
      | "network"
      | "invalid_response",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LLMProviderError";
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
    : fallback;
}

export function llmProviderName(): string {
  const name = process.env.LLM_PROVIDER?.trim().toLowerCase();
  return name || "api";
}

export function llmProviderEnabled(): boolean {
  return llmProviderName() !== "disabled";
}

export function llmApiModel(): string {
  return process.env.LLM_API_MODEL?.trim() || "DeepSeek-V4-Flash";
}

export function llmApiBaseUrl(): string {
  return (process.env.LLM_API_BASE_URL?.trim() || "https://agentrs.jd.com/api/saas/openai-u/v1").replace(/\/+$/u, "");
}

export function llmApiConfigured(): boolean {
  if (llmProviderName() !== "api") return false;
  return Boolean(llmApiBaseUrl() && llmApiModel() && process.env.LLM_API_KEY?.trim());
}

export function llmProviderConfigured(): boolean {
  const name = llmProviderName();
  if (name === "disabled") return false;
  if (name === "api") return llmApiConfigured();
  return false;
}

function logProviderCall(details: Record<string, unknown>): void {
  console.info("LLM provider call", details);
}

function errorForStatus(status: number, message: string): LLMProviderError {
  if (status === 401 || status === 403) {
    return new LLMProviderError(message, "authentication");
  }
  if (status === 429) return new LLMProviderError(message, "rate_limit", true);
  if (status >= 500) return new LLMProviderError(message, "upstream", true);
  return new LLMProviderError(message, "upstream");
}

export class ApiLLMProvider implements LLMProvider {
  constructor(
    private readonly options: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      timeoutMs?: number;
      maxRetries?: number;
      fetcher?: typeof fetch;
    } = {},
  ) {}

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const baseUrl = (this.options.baseUrl ?? llmApiBaseUrl()).replace(/\/+$/u, "");
    const apiKey = this.options.apiKey ?? process.env.LLM_API_KEY?.trim() ?? "";
    const model = this.options.model ?? llmApiModel();
    if (!baseUrl || !apiKey || !model) {
      throw new LLMProviderError("LLM API 配置不完整", "configuration");
    }
    const timeoutMs = this.options.timeoutMs ?? boundedInteger(
      process.env.LLM_API_TIMEOUT_MS,
      30_000,
      1_000,
      180_000,
    );
    const maxRetries = this.options.maxRetries ?? boundedInteger(
      process.env.LLM_API_MAX_RETRIES,
      1,
      0,
      2,
    );
    const fetcher = this.options.fetcher ?? fetch;
    let lastError: LLMProviderError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await fetcher(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            model,
            messages: request.messages,
            temperature: request.temperature ?? 0,
            max_tokens: request.maxTokens ?? boundedInteger(
              process.env.LLM_API_MAX_TOKENS,
              1_024,
              128,
              4_096,
            ),
          }),
        });
        const raw = await response.text();
        let payload: ChatCompletionPayload;
        try {
          payload = JSON.parse(raw) as ChatCompletionPayload;
        } catch {
          throw new LLMProviderError("LLM API 返回了非 JSON 响应", "invalid_response");
        }
        if (!response.ok) {
          const upstreamMessage = typeof payload.error?.message === "string"
            ? payload.error.message.slice(0, 300)
            : `HTTP ${response.status}`;
          throw errorForStatus(response.status, `LLM API 请求失败：${upstreamMessage}`);
        }
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new LLMProviderError("LLM API 返回了空答案或缺少 choices.message.content", "invalid_response");
        }
        const latencyMs = Date.now() - startedAt;
        logProviderCall({ provider: "api", model, latency_ms: latencyMs, success: true, attempt });
        return { content: content.trim(), provider: "api", model, latencyMs };
      } catch (error) {
        const providerError = error instanceof LLMProviderError
          ? error
          : error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
            ? new LLMProviderError("LLM API 请求超时", "timeout", true)
            : new LLMProviderError(
                `LLM API 网络请求失败：${error instanceof Error ? error.message : "未知错误"}`,
                "network",
                true,
              );
        lastError = providerError;
        logProviderCall({
          provider: "api",
          model,
          latency_ms: Date.now() - startedAt,
          success: false,
          reason: providerError.code,
          attempt,
        });
        if (!providerError.retryable || attempt === maxRetries) throw providerError;
      }
    }
    throw lastError ?? new LLMProviderError("LLM API 调用失败", "network");
  }
}

let providerOverride: LLMProvider | undefined;

export function setLLMProviderForTests(provider?: LLMProvider): void {
  providerOverride = provider;
}

export function getLLMProvider(): LLMProvider {
  if (providerOverride) return providerOverride;
  const name = llmProviderName();
  if (name === "api") return new ApiLLMProvider();
  throw new LLMProviderError(`不支持的 LLM_PROVIDER：${name}`, "configuration");
}

export async function answerWithLLM(
  question: string,
  contexts: PackedEvidence[],
  history: ConversationMessage[] = [],
  queryType: QueryType = "local",
): Promise<string> {
  const response = await getLLMProvider().chat({
    messages: buildRagMessages(question, contexts, history, queryType),
  });
  return response.content;
}

export async function answerRefinementWithLLM(
  previousAnswer: string,
  instruction: string,
  contexts: PackedEvidence[] = [],
): Promise<string> {
  const response = await getLLMProvider().chat({
    messages: buildRefinementMessages(previousAnswer, instruction, contexts),
  });
  return response.content;
}
