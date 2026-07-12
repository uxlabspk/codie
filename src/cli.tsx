#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs/promises";
import { LlamaClient } from "./llamaClient.js";
import { ContextManager } from "./contextManager.js";
import { executeTool, getToolDefsForMode, setToolLogSink } from "./tools.js";
import { saveSession, loadSession, listSessions } from "./session.js";
import { App, type AppHandle } from "./App.js";
import { MODE_ORDER, type AgentMode } from "./uiTypes.js";
import instances from "../node_modules/ink/build/instances.js";

const PLANNING_FILE = "planning.md";

const DESIGN_MODE_PROMPT = `You are in DESIGN MODE. The user has described a project and wants you to create a comprehensive implementation plan.

Follow this workflow exactly:

## Step 1: Analyze Requirements
Read the user's project description carefully. Identify:
- Core functionality and features
- Target platform (web, CLI, mobile, etc.)
- Any constraints or preferences mentioned

## Step 2: Decide the Tech Stack
Based on the requirements, choose the best tech stack. For each choice, briefly justify why.
Consider: languages, frameworks, build tools, databases, deployment.

## Step 3: Search for Best Practices
Use the web_search tool to research best practices for your chosen stack. Search for:
- "<chosen framework> best practices <year>"
- "<chosen stack> project structure conventions"
- "<chosen framework> architecture patterns"

Do at least 2 web searches to gather real-world guidance.

## Step 4: Write the Plan
After researching, create a comprehensive plan file at \`plan.md\` using the write_file tool.
The plan MUST include:

### plan.md Structure:
\`\`\`
# Project Plan: <Project Name>

## Tech Stack
- Language: ...
- Framework: ...
- Database: ...
- Build Tool: ...
- Deployment: ...
(Justify each choice briefly)

## Project Structure
(Directory tree with descriptions)

## Architecture
(High-level design, patterns, data flow)

## Implementation Phases
### Phase 1: <Foundation>
- [ ] Step 1 ...
- [ ] Step 2 ...

### Phase 2: <Core Features>
- [ ] ...

### Phase 3: <Polish>
- [ ] ...

## Best Practices Applied
(List the best practices found from web searches and how they apply)

## Dependencies
(List all packages/libraries with versions if known)
\`\`\`

## Step 5: Present and Ask to Proceed
After writing plan.md, present a brief summary of the plan and ask:
"Plan written to plan.md. Ready to proceed with implementation? Say 'go on' to start."

IMPORTANT: Do NOT start implementing yet. Only create the plan. The user will explicitly say "go on" or "proceed" when they want implementation to begin.`;


function getSystemPromptForMode(mode: AgentMode): string {
  const basePrompt = `You are a local coding agent running against the user's own model via llama.cpp.
You can read/write/edit files, list directories, search file contents, and run shell commands using the
provided tools.

Tool use guidelines — follow these strictly:
- Plan before acting. Before calling any tools, think about the minimal set of calls needed to answer.
- Read directly, don't probe. If you know which file is relevant, read it immediately with read_file.
  Do not call list_dir or search_files as a warm-up when you already know the path.
- For large files, use read_file_outline first to get function/class signatures and line numbers,
  then read only the specific sections you need with read_file using start_line/end_line.
- search_files is a last resort. Only use it when you genuinely don't know which file contains something.
  Never issue multiple search_files calls with slightly different patterns in the same turn.
- One call at a time per concept. Do not repeat a tool call with a minor variation if the first result
  was sufficient — draw your conclusion from what you have.
- Stop when you have enough. Once you can answer the user's question, stop calling tools and answer.

Editing guidelines:
- Always inspect a file with read_file before editing it.
- Prefer edit_file for small changes and write_file only for new files or full rewrites.
- When running shell commands, explain briefly what you're about to do first.
- write_file's "content" argument is a JSON string. Any literal double-quote ("") or backslash (\\)
  inside the file content MUST be escaped as \" or \\\\, and raw newlines must be \\n. If a file
  contains long CSS/JS/HTML with quotes, be careful to escape every one of them — a single
  unescaped quote will corrupt the whole tool call and the file will fail to write.

Task decomposition guidelines:
- When the user gives a complex or multi-step task, FIRST break it into a numbered subtask list (todo).
- Present the todo list to the user before starting work.
- Execute subtasks one by one, marking each as [done] before moving to the next.
- If a subtask fails, report it and continue with the next.
- Keep the todo list visible in your responses so progress is clear.

Output guidelines:
- Be concise. When a task is done, say so clearly and stop.
- Format responses in markdown when helpful (code blocks, lists, headers).`;

  if (mode === "agent") {
    return basePrompt;
  }
  
  if (mode === "chat") {
    return `${basePrompt}

IMPORTANT: You are in CHAT mode. You can ONLY use read-only tools (read_file, list_dir, search_files, read_file_outline, get_file_content, get_file_size, get_file_lines). You CANNOT write, edit, or delete files. If the user asks you to write or edit a file, clearly state: "I cannot write or edit files in chat mode. Please switch to agent mode to make file changes."`;
  }
  
  // plan mode
  return `${basePrompt}

IMPORTANT: You are in PLAN mode. You can ONLY use read-only tools (read_file, list_dir, search_files, read_file_outline, get_file_content, get_file_size, get_file_lines). Your conversation will be automatically saved to planning.md in the project root for coding implementation planning. Focus on planning and analyzing code, not on making changes.`;
}

const TOOL_JSON_PARSE_ERROR_PATTERNS = [
  /Failed to parse tool call arguments as JSON/i,
  /invalid string: missing closing quote/i,
  /parse_error\.101/i,
];

const program = new Command();
program
  .name("codie")
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
  let currentMode: AgentMode = "agent";

  let resolveHandle!: (h: AppHandle) => void;
  const handleReady = new Promise<AppHandle>((resolve) => {
    resolveHandle = resolve;
  });

  let uiHandle: AppHandle | null = null;

  const modeHelp = "agent (all tools) | chat (read-only tools) | plan (read-only tools, auto-saves planning.md)";

  function setMode(next: AgentMode, source: string = "mode updated") {
    currentMode = next;
    uiHandle?.setMode(next);
    uiHandle?.addEntry("info", `${source}: ${next} — ${modeHelp}`);
    
    // Add mode change notification to the context so the model is aware
    if (ctxMgr) {
      const modeMessage = next === "chat" 
        ? "NOTE: Mode changed to CHAT. You can ONLY use read-only tools. If asked to write files, respond: 'I cannot write or edit files in chat mode. Please switch to agent mode to make file changes.'"
        : next === "plan"
          ? "NOTE: Mode changed to PLAN. You can ONLY use read-only tools. Focus on planning - your conversation will be saved to planning.md."
          : "NOTE: Mode changed to AGENT. All tools are now available.";
      
      ctxMgr.push({ role: "system", content: modeMessage });
    }
  }

  async function savePlanningFile() {
    if (currentMode !== "plan") return;
    try {
      const planningPath = path.join(cwd, PLANNING_FILE);
      const history = ctxMgr?.getHistory();
      if (!history || history.length === 0) return;

      // Format the conversation history as markdown
      const planningContent = history
        .map((msg) => {
          const roleLabel = msg.role === "user" ? "**User**" : msg.role === "assistant" ? "**Assistant**" : `**${msg.role}**`;
          return `${roleLabel}:\n\n${msg.content}`;
        })
        .join("\n\n---\n\n");

      await fs.mkdir(path.dirname(planningPath), { recursive: true });
      await fs.writeFile(planningPath, planningContent, "utf-8");
      handle.addEntry("info", `📝 planning saved to ${PLANNING_FILE}`);
    } catch (err: any) {
      handle.addEntry("error", `Failed to save planning.md: ${err.message}`);
    }
  }

  // ctxMgr is created asynchronously below (after health/context-size checks),
  // but the Ink UI mounts and starts accepting keystrokes immediately. If a
  // user's Enter keypress lands during that startup window, handleInput would
  // reference ctxMgr before it's assigned. We guard against that here by
  // keeping the input disabled (via setBusy) until setup finishes, and by
  // defensively no-op'ing handleInput if ctxMgr somehow isn't ready yet.
  let ctxMgr: ContextManager | undefined;

  const { waitUntilExit, clear } = render(
    React.createElement(App, {
      cwd,
      initialUsage: { used: 0, budget: 0, ctxSize: 0, pct: 0 },
      initialMode: currentMode,
      onUserInput: (text: string) => void handleInput(text),
      onModeChange: (next: AgentMode) => setMode(next, "mode switched via Ctrl+Tab"),
      onReady: (h: AppHandle) => {
        uiHandle = h;
        resolveHandle(h);
      },
    })
  );

  if (!process.env["CI"]) {
    process.stdout.prependListener("resize", () => {
      const inkInstance = (instances as any).get(process.stdout);
      if (inkInstance) {
        clear();
        process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
        if (inkInstance.fullStaticOutput) {
          process.stdout.write(inkInstance.fullStaticOutput);
        }
      }
    });
  }


  const handle = await handleReady;
  uiHandle = handle;
  handle.setBusy(true, "starting up");

  setToolLogSink((kind, text) => handle.addEntry(kind, text));

  handle.addEntry("info", [
    "",
    "   ██████╗ ██████╗ ██████╗ ██╗███████╗",
    "  ██╔════╝██╔═══██╗██╔══██╗██║██╔════╝",
    "  ██║     ██║   ██║██║  ██║██║█████╗  ",
    "  ██║     ██║   ██║██║  ██║██║██╔══╝  ",
    "  ╚██████╗╚██████╔╝██████╔╝██║███████╗",
    "   ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝╚══════╝",
    "",
    "  v0.2.0 · Your local AI coding agent",
    "  Think it. Type it. Ship it.",
    "",
  ].join("\n"));
  //handle.addEntry("info", `active mode: ${currentMode} — ${modeHelp}`);

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

  // Session memory lives in <cwd>/.codie/<session>/info.md so it's project-local
  const sessionMemoryDir = path.join(cwd, ".codie", opts.session);
  const sessionMemoryPath = path.join(sessionMemoryDir, "info.md");
  await fs.mkdir(sessionMemoryDir, { recursive: true });

  ctxMgr = new ContextManager(client, getSystemPromptForMode(currentMode), {
    reserveForResponse: parseInt(opts.maxTokens, 10),
    keepRecentTurns: parseInt(opts.keepRecent, 10),
    sessionMemoryPath,
  });

  const existing = await loadSession(opts.session);
  if (existing && existing.length > 0) {
    ctxMgr.setHistory(existing);
    handle.addEntry("info", `resumed session "${opts.session}" (${existing.length} messages)`);
  } else {
    // Fresh session — inject prior memory if it exists
    const hadMemory = await ctxMgr.loadMemoryIfExists();
    if (hadMemory) {
      handle.addEntry("info", `📝 loaded session memory from ${sessionMemoryPath}`);
    }
  }
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
      if (!result.compacted) {
        handle.addEntry("info", "nothing to compact yet");
      } else if (result.deepReset) {
        handle.addEntry("info", `🧠 deep reset — memory saved to ${result.memoryPath}, history cleared`);
      } else {
        handle.addEntry("info", `⚙ compacted ${result.removedCount} messages`);
      }
      await refreshStatus();
      return;
    }

    if (trimmed === "/memory") {
      const memPath = ctxMgr.getMemoryPath();
      if (!memPath) {
        handle.addEntry("info", "no session memory path configured");
        return;
      }
      try {
        const content = await fs.readFile(memPath, "utf-8");
        handle.addEntry("info", `📝 memory file (${memPath}):\n\n${content}`);
      } catch {
        handle.addEntry("info", `no memory file yet — will be created automatically when context fills up`);
      }
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

    if (trimmed === "/mode") {
      handle.addEntry("info", `active mode: ${currentMode} — ${modeHelp}`);
      return;
    }

    if (trimmed.startsWith("/mode ")) {
      const requested = trimmed.slice(6).trim().toLowerCase();
      if (MODE_ORDER.includes(requested as AgentMode)) {
        setMode(requested as AgentMode, "mode changed");
      } else {
        handle.addEntry("info", `unknown mode "${requested}". use /mode <agent|chat|plan>`);
      }
      return;
    }

    if (trimmed === "/sessions") {
      const sessions = await listSessions();
      handle.addEntry("info", `sessions: ${sessions.join(", ") || "(none)"}`);
      return;
    }

    if (trimmed === "/save-planning") {
      await savePlanningFile();
      return;
    }

    if (trimmed.startsWith("/design ")) {
      const prompt = trimmed.slice(8).trim();
      if (!prompt) {
        handle.addEntry("info", "usage: /design <project description>");
        return;
      }
      const designMessage = `/design ${prompt}`;
      handle.addEntry("user", designMessage);
      ctxMgr.push({ role: "user", content: designMessage });

      // Inject the design-mode system instructions so the model follows the
      // structured workflow (decide stack → search → write plan → ask to proceed)
      ctxMgr.push({
        role: "system",
        content: DESIGN_MODE_PROMPT,
      });

      handle.setBusy(true, "thinking");
      try {
        await runAgentTurn(ctxMgr);
      } catch (err: any) {
        handle.addEntry("error", `error: ${err.message}`);
      }
      handle.setBusy(false);

      await saveSession(opts.session, ctxMgr.getHistory());
      await refreshStatus();
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
    await savePlanningFile();
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
    // After many chained rounds, stop passing tools to the model so it is
    // forced to give a final answer with what it has — rather than aborting
    // the whole turn with an error. 20 rounds is enough for any real task.
    const SOFT_LIMIT = 20;
    const HARD_LIMIT = 35;

    if (depth >= HARD_LIMIT) {
      // Absolute safety cap — should never be hit in practice
      handle.addEntry("info", `⚠ reached ${HARD_LIMIT} tool-call rounds, wrapping up`);
      // One final call with no tools so the model summarises what it did
      const finalResult = await client.chatStream(ctx.getMessagesForRequest(), {
        maxTokens: parseInt(opts.maxTokens, 10),
        onToken: (t) => handle.setStreamingText((handle as any)._streamingText + t),
      });
      handle.setStreamingText(null);
      if (finalResult.content.trim()) handle.addEntry("assistant", finalResult.content);
      ctx.push({ role: "assistant", content: finalResult.content });
      return;
    }

    const compaction = await ctx.ensureFits();
    if (compaction.compacted) {
      if (compaction.deepReset) {
        handle.addEntry("info", `🧠 context window full — deep reset performed, memory saved to ${compaction.memoryPath}`);
        // History is now [memoryMsg, lastUserMsg]. Reset depth so the agent
        // continues with a fresh round counter instead of hitting the soft limit.
        return await runAgentTurn(ctx, 0);
      } else {
        handle.addEntry("info", `⚙ context was getting full — auto-compacted ${compaction.removedCount} older messages`);
      }
    }

    handle.setBusy(true, "thinking");
    handle.setStreamingText(null);

    let fullText = "";

    // At soft limit, withdraw tools so the model must answer, not keep calling
    const toolsForThisRound = depth >= SOFT_LIMIT ? undefined : getToolDefsForMode(currentMode);
    if (depth === SOFT_LIMIT) {
      handle.addEntry("info", `⚠ many tool rounds completed — asking model to wrap up`);
    }

    const requestMessages = ctx.getMessagesForRequest();

    async function streamAssistantResponse(messages: typeof requestMessages, includeTools: boolean) {
      return await client.chatStream(messages, {
        tools: includeTools ? toolsForThisRound : undefined,
        maxTokens: parseInt(opts.maxTokens, 10),
        onToken: (t) => {
          fullText += t;
          handle.setStreamingText(fullText);
        },
      });
    }

    let result;
    try {
      result = await streamAssistantResponse(requestMessages, true);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      const looksLikeToolJsonParseFailure = TOOL_JSON_PARSE_ERROR_PATTERNS.some((pattern) => pattern.test(message));

      if (!looksLikeToolJsonParseFailure || !toolsForThisRound) {
        throw err;
      }

      // The model likely produced an unescaped quote/backslash inside a large
      // string argument (e.g. write_file content), which corrupts llama-server's
      // grammar-constrained JSON for the whole response and discards everything
      // generated so far. Retrying the identical tools-enabled request is cheap
      // relative to losing the generation outright, and often succeeds since
      // sampling is stochastic — so try that once before giving up on tools.
      handle.addEntry(
        "info",
        "⚠ model emitted invalid tool-call JSON; retrying once with tools before falling back"
      );
      handle.setStreamingText(null);
      fullText = "";
      try {
        result = await streamAssistantResponse(requestMessages, true);
      } catch (retryErr: any) {
        const retryMessage = String(retryErr?.message ?? retryErr);
        const stillLooksLikeToolJsonParseFailure = TOOL_JSON_PARSE_ERROR_PATTERNS.some((pattern) =>
          pattern.test(retryMessage)
        );
        if (!stillLooksLikeToolJsonParseFailure) {
          throw retryErr;
        }
        handle.addEntry(
          "info",
          "⚠ retry also failed with invalid tool-call JSON; falling back to a no-tools response"
        );
        handle.setStreamingText(null);
        fullText = "";
        result = await streamAssistantResponse(requestMessages, false);
      }
    }

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

    const MAX_TOOLS_PER_ROUND = 5;
    if (result.tool_calls.length > MAX_TOOLS_PER_ROUND) {
      handle.addEntry(
        "info",
        `⚠ model requested ${result.tool_calls.length} tool calls at once — limiting to ${MAX_TOOLS_PER_ROUND}`
      );
      result.tool_calls.splice(MAX_TOOLS_PER_ROUND);
    }

    for (const call of result.tool_calls) {
      handle.addEntry("tool", `→ calling ${call.function.name}(${call.function.arguments})`);
      const toolResult = await executeTool(call.function.name, call.function.arguments, currentMode);
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