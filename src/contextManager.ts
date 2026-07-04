import fs from "node:fs/promises";
import path from "node:path";
import { ChatMessage, LlamaClient } from "./llamaClient.js";

export interface CompactionResult {
  compacted: boolean;
  deepReset?: boolean;
  removedCount?: number;
  summaryTokens?: number;
  memoryPath?: string;
  reinjectedUserMessage?: ChatMessage; // set when deepReset re-injects the last user message
}

/**
 * Manages the sliding conversation window so llama-server never receives
 * a request that exceeds its context size.
 *
 * Strategy:
 *  1. Always keep the system prompt.
 *  2. Always keep the last N "recent" turns verbatim (configurable).
 *  3. When projected token usage exceeds the safety threshold:
 *     a. First prune ephemeral tool result messages (free, no LLM call).
 *     b. If still over budget, summarize older turns into a compact memory note.
 *     c. If even that is not enough (history too large to shrink), perform a
 *        deep reset: write a structured info.md to disk, clear all history,
 *        and inject the memory file as a system message so the model resumes
 *        with full context awareness in a fresh window.
 *  4. Reserve headroom for the response (maxTokens) and tool schemas.
 */
export class ContextManager {
  private client: LlamaClient;
  private systemPrompt: ChatMessage;
  private history: ChatMessage[] = [];
  private reserveForResponse: number;
  private keepRecentTurns: number;
  private safetyMarginRatio: number;
  private sessionMemoryPath: string | null;

  constructor(
    client: LlamaClient,
    systemPrompt: string,
    opts: {
      reserveForResponse?: number;
      keepRecentTurns?: number;
      safetyMarginRatio?: number;
      sessionMemoryPath?: string;
    } = {}
  ) {
    this.client = client;
    this.systemPrompt = { role: "system", content: systemPrompt };
    this.reserveForResponse = opts.reserveForResponse ?? 2048;
    this.keepRecentTurns = opts.keepRecentTurns ?? 6;
    this.safetyMarginRatio = opts.safetyMarginRatio ?? 0.85;
    this.sessionMemoryPath = opts.sessionMemoryPath ?? null;
  }

  /**
   * Call after construction. If an info.md exists for this session, inject it
   * as the first history message so the model resumes with prior context.
   */
  async loadMemoryIfExists(): Promise<boolean> {
    if (!this.sessionMemoryPath) return false;
    try {
      const content = await fs.readFile(this.sessionMemoryPath, "utf-8");
      if (!content.trim()) return false;
      this.history = [
        {
          role: "system",
          content: `[Persistent session memory — loaded from previous session]\n${content}`,
        },
      ];
      return true;
    } catch {
      return false;
    }
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

  getMemoryPath(): string | null {
    return this.sessionMemoryPath;
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
      // History is already at minimum size — normal compaction can't help.
      // Fall through to deep reset below.
    } else {
      const cutoff = this.history.length - this.keepRecentTurns;
      const toSummarize = this.history.slice(0, cutoff);
      const recent = this.history.slice(cutoff);

      // Drop tool result messages and their paired assistant tool-call messages
      const toolCallIds = new Set<string>();
      for (const m of toSummarize) {
        if (m.role === "tool" && m.tool_call_id) toolCallIds.add(m.tool_call_id);
      }
      const withoutToolMessages = toSummarize.filter((m) => {
        if (m.role === "tool") return false;
        if (m.role === "assistant" && m.tool_calls?.length) {
          const allPruned = m.tool_calls.every((tc) => toolCallIds.has(tc.id));
          return !allPruned;
        }
        return true;
      });

      // If pruning alone freed enough space, skip the summarization LLM call
      const afterPruneMessages = [this.systemPrompt, ...withoutToolMessages, ...recent];
      const afterPruneTokens = await this.client.countMessageTokens(afterPruneMessages);

      if (afterPruneTokens <= safeBudget) {
        this.history = [...withoutToolMessages, ...recent];
        return { compacted: true, removedCount: toSummarize.length - withoutToolMessages.length };
      }

      // Still too large — summarize the non-tool portion
      const summaryText = await this.summarize(withoutToolMessages.length > 0 ? withoutToolMessages : toSummarize);
      const summaryMessage: ChatMessage = {
        role: "system",
        content: `[Conversation summary of earlier turns, compacted to save context]\n${summaryText}`,
      };

      this.history = [summaryMessage, ...recent];

      // Re-check if summarization was enough
      const afterSummaryTokens = await this.client.countMessageTokens(this.getMessagesForRequest());
      if (afterSummaryTokens <= safeBudget) {
        const summaryTokens = await this.client.tokenize(summaryText);
        return { compacted: true, removedCount: toSummarize.length, summaryTokens };
      }

      // Summarization wasn't enough — fall through to deep reset
    }

    // Deep reset: write full memory to disk, clear history, inject memory message
    return await this.deepReset(toolsTokenEstimate);
  }

  /**
   * Generates a structured info.md capturing all session context, clears
   * history, and injects the memory as a system message. This is the
   * "infinite context" escape hatch — called automatically when the window
   * is too full to compact further, or manually via /memory reset.
   */
  async deepReset(toolsTokenEstimate = 0): Promise<CompactionResult> {
    const memoryContent = await this.generateMemory();
    const memoryPath = await this.writeMemory(memoryContent);

    // Find the last user message so we can re-inject it after the reset.
    // Without it the history would be [systemPrompt, memoryMsg] with no user
    // turn, which causes most model chat templates to reject the request.
    const lastUserMessage = [...this.history].reverse().find((m) => m.role === "user");

    const memoryMessage: ChatMessage = {
      role: "system",
      content: `[Persistent session memory — context window was reset to stay within limits]\n${memoryContent}`,
    };

    // Fresh history: memory note + last user message so the model can continue
    this.history = lastUserMessage
      ? [memoryMessage, lastUserMessage]
      : [memoryMessage];

    return {
      compacted: true,
      deepReset: true,
      memoryPath,
      reinjectedUserMessage: lastUserMessage,
    };
  }

  /**
   * Ask the model to produce a structured markdown memory document from the
   * current full history. Captures: goal, progress, files touched, decisions,
   * pending work, and any constraints.
   */
  private async generateMemory(): Promise<string> {
    const transcript = this.history
      .map((m) => {
        if (m.role === "tool") return `[tool result: ${m.name ?? ""}]\n${(m.content ?? "").slice(0, 500)}`;
        if (m.tool_calls?.length) {
          const calls = m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments})`).join(", ");
          return `[assistant called tools: ${calls}]`;
        }
        return `[${m.role}] ${m.content ?? ""}`;
      })
      .join("\n\n");

    const prompt: ChatMessage[] = [
      {
        role: "system",
        content: `You are a session memory writer for an AI coding assistant. 
Given a conversation transcript, produce a structured markdown document that will be injected into a fresh context window so work can continue seamlessly.

The document MUST contain these sections:
# Session Memory

## Current Goal
What the user is trying to accomplish overall.

## Progress So Far
Bullet list of what has been completed. Be specific: include file names, function names, and what changed.

## Files Touched
List every file that was read, created, or modified, with a one-line note on what was done to each.

## Key Decisions
Important choices made (architecture, approach, trade-offs).

## Current State
Exactly where things stand right now — what was the last thing done or said.

## Next Steps
What needs to happen next to continue the task.

## Constraints & Notes
Anything the user stated as a requirement, preference, or constraint that must be remembered.

Be dense and factual. No pleasantries. Use specific names, paths, and values. Maximum 600 words.`,
      },
      { role: "user", content: transcript },
    ];

    try {
      const result = await this.client.chatStream(prompt, { temperature: 0.1, maxTokens: 800 });
      return result.content.trim() || this.fallbackMemory();
    } catch {
      return this.fallbackMemory();
    }
  }

  private fallbackMemory(): string {
    const lines = this.history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-10)
      .map((m) => `[${m.role}] ${(m.content ?? "").slice(0, 300)}`)
      .join("\n\n");
    return `# Session Memory\n\n## Last Known State\n(Memory generation failed — last ${Math.min(10, this.history.length)} messages)\n\n${lines}`;
  }

  private async writeMemory(content: string): Promise<string> {
    if (!this.sessionMemoryPath) {
      // Fallback: write next to cwd if no path configured
      const fallback = path.join(process.cwd(), ".codie", "info.md");
      await fs.mkdir(path.dirname(fallback), { recursive: true });
      await fs.writeFile(fallback, content, "utf-8");
      return fallback;
    }
    await fs.mkdir(path.dirname(this.sessionMemoryPath), { recursive: true });
    await fs.writeFile(this.sessionMemoryPath, content, "utf-8");
    return this.sessionMemoryPath;
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
