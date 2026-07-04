import fetch from "node-fetch";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionChunk {
  choices: Array<{
    delta: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
}

export class LlamaClient {
  baseUrl: string;
  contextSize: number | null = null;

  constructor(baseUrl = "http://localhost:8080") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** Ask the server how many tokens a given text/messages blob is. Uses the model's real tokenizer. */
  async tokenize(text: string): Promise<number> {
    try {
      const res = await fetch(`${this.baseUrl}/tokenize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) throw new Error(`tokenize failed: ${res.status}`);
      const data = (await res.json()) as { tokens: number[] };
      return data.tokens.length;
    } catch {
      // fallback heuristic: ~4 chars/token
      return Math.ceil(text.length / 4);
    }
  }

  async countMessageTokens(messages: ChatMessage[]): Promise<number> {
    // Rough serialization matching chat-template overhead reasonably well.
    const joined = messages
      .map((m) => `${m.role}: ${m.content ?? ""} ${m.tool_calls ? JSON.stringify(m.tool_calls) : ""}`)
      .join("\n");
    const base = await this.tokenize(joined);
    // add small per-message overhead for role/formatting tokens
    return base + messages.length * 4;
  }

  /** Discover the server's configured context window via /props (llama.cpp server endpoint). */
  async getContextSize(): Promise<number> {
    if (this.contextSize) return this.contextSize;
    try {
      const res = await fetch(`${this.baseUrl}/props`);
      if (res.ok) {
        const data = (await res.json()) as { default_generation_settings?: { n_ctx?: number }; n_ctx?: number };
        const n = data.n_ctx ?? data.default_generation_settings?.n_ctx;
        if (n) {
          this.contextSize = n;
          return n;
        }
      }
    } catch {
      /* ignore */
    }
    // Sensible default if the server doesn't expose it
    this.contextSize = 4096;
    return this.contextSize;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Streaming chat completion against llama-server's OpenAI-compatible endpoint.
   * Calls onToken for text deltas and returns the final assembled message
   * (including any tool_calls the model requested).
   */
  async chatStream(
    messages: ChatMessage[],
    opts: {
      tools?: ToolDef[];
      temperature?: number;
      maxTokens?: number;
      onToken?: (t: string) => void;
      signal?: AbortSignal;
    } = {}
  ): Promise<{ content: string; tool_calls: ToolCall[]; finish_reason: string }> {
    const body: Record<string, unknown> = {
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 2048,
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`llama-server error ${res.status}: ${text}`);
    }

    let content = "";
    const toolCallsAcc: Record<number, ToolCall> = {};
    let finishReason = "stop";

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Buffer, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        let parsed: ChatCompletionChunk;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          content += choice.delta.content;
          opts.onToken?.(choice.delta.content);
        }
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallsAcc[idx]) {
              toolCallsAcc[idx] = { id: tc.id ?? `call_${idx}`, type: "function", function: { name: "", arguments: "" } };
            }
            if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }

    return { content, tool_calls: Object.values(toolCallsAcc), finish_reason: finishReason };
  }
}
