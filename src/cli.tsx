#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { LlamaClient } from "./llamaClient.js";
import { ContextManager } from "./contextManager.js";
import { toolDefs, executeTool, setToolLogSink } from "./tools.js";
import { saveSession, loadSession, listSessions } from "./session.js";
import { App, type AppHandle } from "./App.js";

const SYSTEM_PROMPT = `You are a local coding agent running against the user's own model via llama.cpp.
You can read/write/edit files, list directories, search file contents, and run shell commands using the
provided tools. Always inspect a file with read_file before editing it. Prefer edit_file for small changes
and write_file only for new files or full rewrites. When running shell commands, explain briefly what you're
about to do first. Be concise. When a task is done, say so clearly and stop. Format your responses in
markdown when helpful (code blocks, lists, headers).`;

const program = new Command();
program
  .name("llama-agent")
  .description("Local agentic coding CLI for llama.cpp servers with automatic context compaction")
  .option("-u, --url <url>", "llama-server base URL", "http://localhost:8080")
  .option("-s, --session <name>", "session name to load/save", "default")
  .option("--max-tokens <n>", "max tokens per response", "2048")
  .option("--keep-recent <n>", "messages to keep verbatim before compacting", "6")
  .parse(process.argv);

const opts = program.opts();

async function main() {
  const client = new LlamaClient(opts.url);
  const cwd = process.cwd();

  let resolveHandle!: (h: AppHandle) => void;
  const handleReady = new Promise<AppHandle>((resolve) => {
    resolveHandle = resolve;
  });

  // ctxMgr is created asynchronously below (after health/context-size checks),
  // but the Ink UI mounts and starts accepting keystrokes immediately. If a
  // user's Enter keypress lands during that startup window, handleInput would
  // reference ctxMgr before it's assigned. We guard against that here by
  // keeping the input disabled (via setBusy) until setup finishes, and by
  // defensively no-op'ing handleInput if ctxMgr somehow isn't ready yet.
  let ctxMgr: ContextManager | undefined;

  const { waitUntilExit } = render(
    React.createElement(App, {
      cwd,
      initialUsage: { used: 0, budget: 0, ctxSize: 0, pct: 0 },
      onUserInput: (text: string) => void handleInput(text),
      onReady: (h: AppHandle) => resolveHandle(h),
    })
  );

  const handle = await handleReady;
  handle.setBusy(true, "starting up");

  setToolLogSink((kind, text) => handle.addEntry(kind, text));

  handle.addEntry("info", `llama-agent → ${opts.url}`);

  const healthy = await client.health();
  if (!healthy) {
    handle.addEntry("error", `Cannot reach llama-server at ${opts.url}`);
    handle.addEntry(
      "error",
      `Start it with: llama-server -m your-model.gguf -c 8192 --host 0.0.0.0 --port 8080`
    );
    setTimeout(() => process.exit(1), 2000);
    return;
  }

  const ctxSize = await client.getContextSize();
  handle.addEntry("info", `context size: ${ctxSize} tokens`);

  ctxMgr = new ContextManager(client, SYSTEM_PROMPT, {
    reserveForResponse: parseInt(opts.maxTokens, 10),
    keepRecentTurns: parseInt(opts.keepRecent, 10),
  });

  const existing = await loadSession(opts.session);
  if (existing && existing.length > 0) {
    ctxMgr.setHistory(existing);
    handle.addEntry("info", `resumed session "${opts.session}" (${existing.length} messages)`);
  }
  handle.addEntry("info", `commands: /compact  /usage  /save  /sessions  /clear  /exit`);

  handle.setBusy(false);
  await refreshStatus();

  async function refreshStatus() {
    if (!ctxMgr) return;
    const info = await ctxMgr.usageInfo();
    handle.setUsage(info);
  }

  async function handleInput(trimmed: string) {
    if (!ctxMgr) {
      // Setup hasn't finished yet (shouldn't normally happen since input is
      // disabled during startup, but guard against it defensively anyway).
      handle.addEntry("info", "still starting up, one moment...");
      return;
    }
    if (trimmed === "/exit" || trimmed === "/quit") {
      await saveSession(opts.session, ctxMgr.getHistory());
      handle.addEntry("info", "session saved. bye!");
      setTimeout(() => process.exit(0), 300);
      return;
    }

    if (trimmed === "/usage") {
      await refreshStatus();
      const info = await ctxMgr.usageInfo();
      handle.addEntry("info", `${info.used} / ${info.budget} tokens used (${info.pct}%) — ctx size ${info.ctxSize}`);
      return;
    }

    if (trimmed === "/compact") {
      handle.addEntry("info", "compacting...");
      const result = await ctxMgr.ensureFits();
      handle.addEntry(
        "info",
        result.compacted ? `compacted ${result.removedCount} messages into a summary` : "nothing to compact yet"
      );
      await refreshStatus();
      return;
    }

    if (trimmed === "/clear") {
      ctxMgr.setHistory([]);
      handle.addEntry("info", "history cleared");
      await refreshStatus();
      return;
    }

    if (trimmed === "/save") {
      const f = await saveSession(opts.session, ctxMgr.getHistory());
      handle.addEntry("info", `saved to ${f}`);
      return;
    }

    if (trimmed === "/sessions") {
      const sessions = await listSessions();
      handle.addEntry("info", `sessions: ${sessions.join(", ") || "(none)"}`);
      return;
    }

    handle.addEntry("user", trimmed);
    ctxMgr.push({ role: "user", content: trimmed });

    handle.setBusy(true, "thinking");
    try {
      await runAgentTurn(ctxMgr);
    } catch (err: any) {
      handle.addEntry("error", `error: ${err.message}`);
    }
    handle.setBusy(false);

    await saveSession(opts.session, ctxMgr.getHistory());
    await refreshStatus();
  }

  /**
   * Runs one agent turn: shows a thinking spinner until the first token arrives,
   * streams the response into the live preview, finalizes it as markdown once
   * complete, handles any tool calls, feeds results back, and loops until the
   * model gives a final answer. Auto-compaction is enforced before every request.
   * ctxMgr is passed explicitly (rather than closed over) so it's guaranteed
   * defined here — this function is only ever invoked after the startup guard
   * above has confirmed initialization finished.
   */
  async function runAgentTurn(ctx: ContextManager, depth = 0) {
    if (depth > 8) {
      handle.addEntry("error", "(stopping: too many chained tool calls)");
      return;
    }

    const compaction = await ctx.ensureFits();
    if (compaction.compacted) {
      handle.addEntry("info", `⚙ context was getting full — auto-compacted ${compaction.removedCount} older messages`);
    }

    handle.setBusy(true, "thinking");
    handle.setStreamingText(null);

    let fullText = "";
    let firstToken = true;

    const result = await client.chatStream(ctx.getMessagesForRequest(), {
      tools: toolDefs,
      maxTokens: 2048,
      onToken: (t) => {
        if (firstToken) {
          firstToken = false;
        }
        fullText += t;
        handle.setStreamingText(fullText);
      },
    });

    handle.setStreamingText(null);

    if (fullText.trim()) {
      handle.addEntry("assistant", fullText);
    }

    ctx.push({
      role: "assistant",
      content: result.content,
      ...(result.tool_calls.length ? { tool_calls: result.tool_calls } : {}),
    });

    if (result.tool_calls.length === 0) {
      return;
    }

    for (const call of result.tool_calls) {
      handle.addEntry("tool", `→ calling ${call.function.name}(${call.function.arguments})`);
      const toolResult = await executeTool(call.function.name, call.function.arguments);
      ctx.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: toolResult,
      });
    }

    await runAgentTurn(ctx, depth + 1);
  }

  await waitUntilExit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
