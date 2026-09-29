import { logError, logInfo, logWarn } from "../logging";
import type { ErrorKind } from "../types";

export interface ChatMessageIn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessageIn[];
  temperature: number;
  maxTokens: number;
  stream: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void | Promise<void>;
}

export interface CompletionResult {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = "LlmError";
  }
}

interface ApiErrorBody {
  error?: { message?: string; type?: string; code?: string };
  message?: string;
}

const MAX_RETRIES = 3;

export async function complete(req: CompletionRequest): Promise<CompletionResult> {
  const url = `${req.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    stream: req.stream
  };

  let lastError: LlmError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
      logInfo(`retrying request in ${backoff}ms (attempt ${attempt + 1})`);
      await delay(backoff, req.signal);
    }

    try {
      return req.stream ? await streamOnce(url, req, body) : await once(url, req, body);
    } catch (err) {
      const error = toLlmError(err);
      if (error.kind === "aborted") {
        throw error;
      }
      lastError = error;
      const retryable = error.kind === "rate_limit" || error.kind === "server" || error.kind === "network";
      if (!retryable || attempt === MAX_RETRIES) {
        throw error;
      }
      logWarn(`retryable ${error.kind} error: ${error.message}`);
    }
  }

  throw lastError ?? new LlmError("Request failed", "unknown");
}

async function once(
  url: string,
  req: CompletionRequest,
  body: unknown
): Promise<CompletionResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ...(body as object), stream: false }),
    signal: req.signal
  });

  if (!res.ok) {
    throw await httpError(res);
  }

  const json = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) {
    throw new LlmError("The model returned an empty response.", "empty");
  }

  return {
    text,
    model: json.model ?? req.model,
    promptTokens: json.usage?.prompt_tokens,
    completionTokens: json.usage?.completion_tokens,
    finishReason: json.choices?.[0]?.finish_reason
  };
}

async function streamOnce(
  url: string,
  req: CompletionRequest,
  body: unknown
): Promise<CompletionResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    },
    body: JSON.stringify(body),
    signal: req.signal
  });

  if (!res.ok) {
    throw await httpError(res);
  }

  if (!res.body) {
    return once(url, req, body);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let raw = "";
  let text = "";
  let model = req.model;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let finishReason: string | undefined;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const decoded = decoder.decode(value, { stream: true });
      buffer += decoded;
      if (raw.length < 8192) {
        raw += decoded;
      }

      let split: Boundary | null;
      while ((split = indexOfBoundary(buffer)) !== null) {
        const chunk = buffer.slice(0, split.at);
        buffer = buffer.slice(split.next);
        const delta = handleChunk(chunk);
        if (delta) {
          text += delta;
          await req.onDelta?.(delta);
        }
      }
    }
    const tail = handleChunk(buffer);
    if (tail) {
      text += tail;
      await req.onDelta?.(tail);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw toLlmError(err);
  }

  function handleChunk(chunk: string): string {
    let out = "";
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      try {
        const parsed = JSON.parse(data) as {
          model?: string;
          choices?: {
            delta?: { content?: string };
            message?: { content?: string };
            finish_reason?: string;
          }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          error?: { message?: string };
        };
        if (parsed.error?.message) {
          throw new LlmError(parsed.error.message, "server");
        }
        if (parsed.model) {
          model = parsed.model;
        }
        if (parsed.usage) {
          promptTokens = parsed.usage.prompt_tokens;
          completionTokens = parsed.usage.completion_tokens;
        }
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
        const piece = choice?.delta?.content ?? choice?.message?.content ?? "";
        if (piece) {
          out += piece;
        }
      } catch (err) {
        if (err instanceof LlmError) {
          throw err;
        }
        logWarn("skipping unparsable SSE payload");
      }
    }
    return out;
  }

  if (!text.trim()) {
    // Some providers answer a streaming request with a plain JSON error body
    // and a 200 status, so check for that before reporting "empty".
    const embedded = extractEmbeddedError(raw);
    if (embedded) {
      throw embedded;
    }
    throw new LlmError("The model returned an empty response.", "empty");
  }

  return { text, model, promptTokens, completionTokens, finishReason };
}

function extractEmbeddedError(raw: string): LlmError | undefined {
  if (!raw.includes("error") || !raw.trimStart().startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as ApiErrorBody;
    const message = parsed?.error?.message ?? parsed?.message;
    return message ? new LlmError(String(message), "server") : undefined;
  } catch {
    return undefined;
  }
}

interface Boundary {
  at: number;
  next: number;
}

function indexOfBoundary(buffer: string): Boundary | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) {
    return null;
  }
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { at: crlf, next: crlf + 4 };
  }
  return { at: lf, next: lf + 2 };
}

async function httpError(res: Response): Promise<LlmError> {
  let detail = "";
  let parsed: ApiErrorBody | undefined;
  try {
    parsed = (await res.json()) as ApiErrorBody;
    detail = parsed?.error?.message ?? parsed?.message ?? "";
  } catch {
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      detail = "";
    }
  }

  const message = detail || `Request failed with HTTP ${res.status}`;

  if (res.status === 401 || res.status === 403) {
    return new LlmError(
      `${message}. Check the API key for the configured provider.`,
      "auth",
      res.status
    );
  }
  if (res.status === 429) {
    return new LlmError(`${message}. Rate limited or out of quota.`, "rate_limit", res.status);
  }
  if (res.status >= 500) {
    return new LlmError(`${message}. The provider had a server error.`, "server", res.status);
  }
  if (res.status === 404) {
    return new LlmError(
      `${message}. The endpoint or model was not found - verify knightrider.apiBaseUrl and knightrider.model.`,
      "server",
      res.status
    );
  }
  return new LlmError(message, "unknown", res.status);
}

/**
 * Bridges VS Code's CancellationToken to a web AbortSignal so the same client
 * works from the webview flow and from the native chat participant.
 */
export function toAbortSignal(token: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => { dispose(): void } }): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  } else {
    const sub = token.onCancellationRequested(() => controller.abort());
    return {
      signal: controller.signal,
      dispose: () => sub.dispose()
    };
  }
  return { signal: controller.signal, dispose: () => undefined };
}

export function toLlmError(err: unknown): LlmError {  if (err instanceof LlmError) {
    return err;
  }
  const name = (err as { name?: string } | undefined)?.name;
  const raw = err instanceof Error ? err.message : String(err);

  if (name === "AbortError" || raw === "aborted") {
    return new LlmError("Request cancelled.", "aborted");
  }
  if (name === "TimeoutError") {
    return new LlmError("The request timed out.", "timeout");
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|network/i.test(raw)) {
    return new LlmError(`Could not reach the model provider: ${raw}`, "network");
  }
  logError("unclassified provider error", err);
  return new LlmError(raw || "Unknown error", "unknown");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError("Request cancelled.", "aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmError("Request cancelled.", "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
