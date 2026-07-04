# codie

A local, agentic coding CLI for `llama.cpp`'s `llama-server`, built with **Ink (React for
terminals)**. It has automatic context compaction so the server never fails when the
context window fills up, plus a proper multi-panel UI: fixed bottom input bar, scrollable
history, markdown rendering, a thinking spinner, and shell-style command history.

## Why Ink

The first version of this tool used `blessed`, an older imperative terminal-UI library.
It hit real, hard-to-fix bugs: multi-line streamed output collapsing to one line, no way
to scroll finalized output, and up/down history navigation that silently never worked
because `blessed`'s `Textbox` widget has an explicitly unfinished
`// TODO: Handle directional keys` in its own source.

Ink (used by Gemini CLI, Claude Code, and Codex's CLI) solves all of this natively:
- **`<Static>`** renders permanent scrollback efficiently — finalized messages never re-render
- **`useInput`** is a well-supported, documented hook with working arrow-key detection
- **Flexbox layout** via `<Box>` makes pinning an input bar to the bottom trivial
- Everything is normal React state — no manual line-buffer mutation

## Why this exists (the original problem)

`llama-server`'s context window (`-c` at startup) is fixed. If you keep sending the full
conversation history and it exceeds that limit, the server rejects the request or
truncates unpredictably — which looks like "it just stops working."

This tool solves that client-side, the way hosted AI products do: it tracks real token
usage (via `llama-server`'s own `/tokenize` endpoint) and, before the context overflows,
summarizes older turns into a compact note and drops the originals, keeping recent turns
verbatim. You'll never hit a hard context wall.

## Setup

```bash
npm install
npm run build
```

Start your llama-server as usual, with a reasonably large context:

```bash
llama-server -m /path/to/model.gguf -c 8192 --host 0.0.0.0 --port 8080
```

> Tool calling requires a model/template that supports OpenAI-style function calling
> (e.g. Qwen2.5-Coder, Hermes-3, recent Llama instruct with function-calling templates).
> If your model doesn't support it, tool calls just won't be emitted — you can still chat.

Run the CLI:

```bash
npm start -- --url http://localhost:8080 --session myproject
```

or after a global link:

```bash
npm link
codie --url http://localhost:8080
```

## UI

- **Bottom input bar**: bordered box, always focused, with a status line below showing
  cwd (left) and live token usage color-coded by how close you are to the context limit
  (green/yellow/red).
- **Markdown rendering**: headers, bold, lists, and syntax-aware code blocks render with
  real ANSI styling once a response finishes streaming.
- **Thinking spinner**: animates from the moment you hit enter until the first token
  arrives, then switches to a live raw-text preview of the streaming response.
- **Command history**: press ↑/↓ to cycle through previous messages, exactly like a shell.
- **Colorized diffs**: file edits show a proper +/- diff, green/red, instead of raw patch text.

### Slash commands

| Command      | Effect                                              |
|--------------|------------------------------------------------------|
| `/usage`     | Show current token usage vs. budget                  |
| `/compact`   | Force compaction now                                 |
| `/save`      | Save session to disk                                 |
| `/sessions`  | List saved sessions                                  |
| `/clear`     | Wipe current history (keeps system prompt)           |
| `/exit`      | Save and quit                                        |

Sessions auto-save after every turn to `~/.codie/sessions/<name>.json`, so a crash
or Ctrl+C doesn't lose your work — resume with `--session <name>`.

## Tuning compaction

```bash
codie --keep-recent 8 --max-tokens 3072
```

- `--keep-recent`: how many raw messages stay verbatim before older ones get summarized.
- `--max-tokens`: reserved headroom for each response; also subtracted from the
  compaction budget so a big response never gets cut off by a full context.

## Architecture

```
src/
  llamaClient.ts       — OpenAI-compatible client for llama-server (/v1/chat/completions,
                          /tokenize, /props), streaming + tool call parsing
  contextManager.ts    — token budget tracking + auto-summarization/compaction
  tools.ts             — read_file, read_file_outline, write_file, edit_file, list_dir, search_files,
                          run_shell_command implementations + JSON schemas
  session.ts           — save/resume conversations to disk
  markdown.ts           — markdown → ANSI rendering, hardened against terminal-size
                          detection edge cases
  uiTypes.ts           — shared log-entry types
  App.tsx              — root Ink component: layout, state, imperative handle for the
                          async cli.tsx driver to push updates into React state
  LogLine.tsx          — renders one finalized entry (user/assistant/info/error/tool/diff)
  InputBar.tsx         — bordered TextInput + shell-style history navigation
  StatusBar.tsx        — cwd + token usage display
  ThinkingIndicator.tsx — spinner shown while waiting for the first token
  StreamingPreview.tsx  — live raw-text view of the in-progress response
  cli.tsx              — entrypoint: wires everything together, runs the agent loop
                          (request → tool calls → tool results → repeat)
```

## Limitations / next steps

- Tool-call support depends entirely on your model + its chat template exposing
  OpenAI-style `tool_calls`. Not all GGUF models do.
- Summarization uses the same local model, so aggressive compaction costs an extra
  generation each time it triggers — deliberate trade-off (your own compute, no external calls).
- No sandboxing beyond "stay inside the working directory" for file tools;
  `run_shell_command` executes real shell commands — review what the agent proposes
  before trusting it in sensitive directories.

