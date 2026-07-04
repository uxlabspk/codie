import { ChatMessage, LlamaClient } from "./llamaClient.js";

export interface CompactionResult {
  compacted: boolean;
  removedCount?: number;
  summaryTokens?: number;
}

/**
 * Manages the sliding conversation window so llama-server never receives
 * a request that exceeds its context size.
 *
 * Strategy (mirrors what Claude Code / Gemini CLI do internally):
 *  1. Always keep the system prompt.
 *  2. Always keep the last N "recent" turns verbatim (configurable).
 *  3. When projected token usage exceeds the safety threshold, take the
 *     oldest non-recent messages and ask the model to summarize them into
 *     a single compact "memory" message, then replace them with it.
 *  4. Reserve headroom for the response (maxTokens) and tool schemas.
 */
export class ContextManager {
  private client: LlamaClient;
  private systemPrompt: ChatMessage;
  private history: ChatMessage[] = [];
  private reserveForResponse: number;
  private keepRecentTurns: number;
  private safetyMarginRatio: number;

  constructor(
    client: LlamaClient,
    systemPrompt: string,
    opts: { reserveForResponse?: number; keepRecentTurns?: number; safetyMarginRatio?: number } = {}
  ) {
    this.client = client;
    this.systemPrompt = { role: "system", content: systemPrompt };
    this.reserveForResponse = opts.reserveForResponse ?? 2048;
    this.keepRecentTurns = opts.keepRecentTurns ?? 6; // 6 messages ~ 3 user/assistant pairs
    this.safetyMarginRatio = opts.safetyMarginRatio ?? 0.85; // trigger compaction at 85% of budget
  }

  push(message: ChatMessage) {
    this.history.push(message);
  }

  getMessagesForRequest(): ChatMessage[] {
    return [this.systemPrompt, ...this.history];
  }

  getHistory(): ChatMessage[] {
    return this.history;
  }

  setHistory(h: ChatMessage[]) {
    this.history = h;
  }

  /**
   * Checks current token usage against the context budget and compacts
   * (summarizes older messages) if needed. Call this before every request.
   */
  async ensureFits(toolsTokenEstimate = 0): Promise<CompactionResult> {
    const ctxSize = await this.client.getContextSize();
    const budget = ctxSize - this.reserveForResponse - toolsTokenEstimate;
    const safeBudget = Math.floor(budget * this.safetyMarginRatio);

    let used = await this.client.countMessageTokens(this.getMessagesForRequest());

    if (used <= safeBudget) {
      return { compacted: false };
    }

    // Need to compact. Keep the most recent `keepRecentTurns` messages verbatim;
    // summarize everything else (excluding system prompt).
    if (this.history.length <= this.keepRecentTurns) {
      // Nothing meaningful left to compact â€” truncate oldest as last resort.
      const dropped = this.history.shift();
      return { compacted: true, removedCount: dropped ? 1 : 0 };
    }

    const cutoff = this.history.length - this.keepRecentTurns;
    const toSummarize = this.history.slice(0, cutoff);
    const recent = this.history.slice(cutoff);

    const summaryText = await this.summarize(toSummarize);
    const summaryMessage: ChatMessage = {
      role: "system",
      content: `[Conversation summary of earlier turns, compacted to save context]\n${summaryText}`,
    };

    this.history = [summaryMessage, ...recent];

    const summaryTokens = await this.client.tokenize(summaryText);
    return { compacted: true, removedCount: toSummarize.length, summaryTokens };
  }

  private async summarize(messages: ChatMessage[]): Promise<string> {
    const transcript = messages
      .map((m) => {
        if (m.role === "tool") return `[tool result: ${m.name ?? ""}] ${m.content}`;
        if (m.tool_calls?.length) {
          const calls = m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments})`).join(", ");
          return `[assistant called tools] ${calls}`;
        }
        return `[${m.role}] ${m.content}`;
      })
      .join("\n");

    const prompt: ChatMessage[] = [
      {
        role: "system",
        content:
          "You compress conversation history for an AI coding assistant. Summarize the following exchange " +
          "into a dense, factual note. Preserve: file paths touched, key decisions, code changes made, current " +
          "task/goal, unresolved TODOs, and any constraints the user stated. Omit pleasantries. Output plain text, " +
          "no preamble, under 400 words.",
      },
      { role: "user", content: transcript },
    ];

    try {
      const result = await this.client.chatStream(prompt, { temperature: 0.1, maxTokens: 600 });
      return result.content.trim() || "(summary unavailable)";
    } catch {
      // If summarization itself fails, fall back to a crude truncated transcript
      return transcript.slice(0, 2000);
    }
  }

  async usageInfo(): Promise<{ used: number; budget: number; ctxSize: number; pct: number }> {
    const ctxSize = await this.client.getContextSize();
    const budget = ctxSize - this.reserveForResponse;
    const used = await this.client.countMessageTokens(this.getMessagesForRequest());
    return { used, budget, ctxSize, pct: Math.round((used / budget) * 100) };
  }
}
