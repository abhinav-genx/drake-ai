import "dotenv/config";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterOptions {
  /** Model slug, e.g. "openai/gpt-4o" or "anthropic/claude-3.5-sonnet". */
  model?: string;
  /** Sampling temperature (0-2). */
  temperature?: number;
  /** Maximum number of tokens to generate. */
  maxTokens?: number;
  /** Full conversation history. Takes precedence over `system` when provided. */
  messages?: ChatMessage[];
  /** Optional system prompt used when `messages` is not provided. */
  system?: string;
  /** Override the API key (defaults to process.env.OPENROUTER_API_KEY). */
  apiKey?: string;
  /** Sent as HTTP-Referer, used by OpenRouter for app attribution. */
  referer?: string;
  /** Sent as X-Title, used by OpenRouter for app attribution. */
  title?: string;
  /** Optional AbortSignal to cancel the request. */
  signal?: AbortSignal;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: { role: string; content: string };
  }>;
  error?: { message: string };
}

/**
 * Send a prompt to OpenRouter and return the assistant's text response.
 *
 * @param prompt - The user prompt to send.
 * @param options - Optional configuration (model, temperature, history, etc.).
 * @returns The assistant's reply as a string.
 */
export async function sendPrompt(
  prompt: string,
  options: OpenRouterOptions = {},
): Promise<string> {
  const {
    // Orchestrator model (plans sub-agents / writes the XML). Prefer a strong
    // model for reliable multi-step planning; override via OPENROUTER_MODEL.
    model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5",
    temperature,
    maxTokens,
    messages,
    system,
    apiKey = process.env.OPENROUTER_API_KEY,
    referer = process.env.OPENROUTER_SITE_URL,
    title = process.env.OPENROUTER_APP_NAME,
    signal,
  } = options;

  if (!apiKey) {
    throw new Error(
      "Missing OpenRouter API key. Set OPENROUTER_API_KEY or pass options.apiKey.",
    );
  }

  const finalMessages: ChatMessage[] =
    messages ??
    [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      { role: "user" as const, content: prompt },
    ];

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (referer) headers["HTTP-Referer"] = referer;
  if (title) headers["X-Title"] = title;

  const res = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: finalMessages,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    }),
    ...(signal ? { signal } : {}),
  });

  const data = (await res.json()) as OpenRouterResponse;

  if (!res.ok) {
    throw new Error(
      `OpenRouter request failed (${res.status}): ${
        data.error?.message ?? res.statusText
      }`,
    );
  }

  const content = data.choices?.[0]?.message?.content;
  if (content === undefined) {
    throw new Error("OpenRouter response did not contain any content.");
  }

  return content;
}
