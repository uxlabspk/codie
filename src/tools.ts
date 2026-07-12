import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import fetch from "node-fetch";
import type { ToolDef } from "./llamaClient.js";
import type { AgentMode } from "./uiTypes.js";

const execAsync = promisify(exec);
const CWD = process.cwd();

/** Optional sink for tool activity logs. Set by the CLI/UI layer so tool output
 *  renders as properly styled Ink components instead of raw console writes. */
export type ToolLogKind = "tool" | "diff";
let logSink: ((kind: ToolLogKind, text: string) => void) | null = null;
export function setToolLogSink(sink: (kind: ToolLogKind, text: string) => void) {
  logSink = sink;
}
function log(kind: ToolLogKind, text: string) {
  if (logSink) logSink(kind, text);
  else console.log(text);
}

function resolveSafe(p: string): string {
  const resolved = path.resolve(CWD, p);
  if (!resolved.startsWith(CWD)) {
    throw new Error(`Refusing to access path outside working directory: ${p}`);
  }
  return resolved;
}

export const toolDefs: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file, optionally a line range. Use before editing a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          start_line: { type: "number", description: "1-indexed start line (optional)" },
          end_line: { type: "number", description: "1-indexed end line, inclusive (optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file or overwrite an existing file with given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit a file by replacing an exact substring match with new text. old_text must match exactly once in the file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string", description: "Exact existing text to find (must be unique in file)" },
          new_text: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories at a given path (non-recursive by default).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path, default '.'" },
          recursive: { type: "boolean", description: "List recursively, default false" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for a text pattern across files (like grep -rn). Returns matching lines with file:line.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text or regex pattern to search for" },
          path: { type: "string", description: "Directory to search in, default '.'" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file_outline",
      description:
        "Get a compact outline of a source file: function/class/method signatures with line numbers, " +
        "without reading the full file contents. Use this first to understand a file's structure, " +
        "then use read_file with start_line/end_line to read only the sections you need.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell_command",
      description: "Execute a shell command in the working directory. Use for running tests, builds, git, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_file_content",
      description: "Read the entire contents of a file. Use when you want to read a file without line range constraints.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          encoding: { type: "string", description: "File encoding (default: utf-8)", enum: ["utf-8", "utf-16"] },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_file_size",
      description: "Get the size of a file in bytes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_file_lines",
      description: "Get the number of lines in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for information using DuckDuckGo. Returns titles, snippets, and URLs. " +
        "Use for finding best practices, documentation, tutorials, library recommendations, " +
        "architecture patterns, or any factual information not in your training data.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string" },
          num_results: {
            type: "number",
            description: "Number of results to return (default 5, max 10)",
          },
        },
        required: ["query"],
      },
    },
  },
];

const READ_TOOL_NAMES = new Set([
  "read_file",
  "list_dir",
  "search_files",
  "read_file_outline",
  "get_file_content",
  "get_file_size",
  "get_file_lines",
  "web_search",
]);

export function getToolDefsForMode(mode: AgentMode): ToolDef[] {
  if (mode === "agent") return toolDefs;
  // chat mode: read-only tools only
  return toolDefs.filter((def) => READ_TOOL_NAMES.has(def.function.name));
}

function validateToolAccess(mode: AgentMode, name: string, args: any): string | null {
  if (mode === "agent") return null;
  // chat mode: read-only only
  return READ_TOOL_NAMES.has(name) ? null : `Error: tool ${name} is blocked in chat mode (read-only).`;
}

const TOOL_RESULT_CHAR_LIMIT = 8000;

function truncateResult(result: string, toolName: string): string {
  if (result.length <= TOOL_RESULT_CHAR_LIMIT) return result;
  const kept = result.slice(0, TOOL_RESULT_CHAR_LIMIT);
  const dropped = result.length - TOOL_RESULT_CHAR_LIMIT;
  return (
    kept +
    `\n\n[... truncated ${dropped} chars — use read_file with start_line/end_line or a more specific search to see more]`
  );
}

async function scrapeDuckDuckGo(query: string, numResults: number): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo request failed: ${res.status}`);
  }

  const html = await res.text();
  const results: { title: string; snippet: string; url: string }[] = [];

  // Match result blocks: each result has a link with class "result__a" and a snippet
  const titleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const titles: { url: string; title: string }[] = [];
  let match;
  while ((match = titleRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    // DuckDuckGo wraps URLs in a redirect; extract the actual URL
    const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
    const actualUrl = uddgMatch ? decodeURIComponent(uddgMatch[1]) : rawUrl;
    titles.push({ url: actualUrl, title });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(match[1].replace(/<[^>]+>/g, "").trim());
  }

  for (let i = 0; i < Math.min(titles.length, numResults, snippets.length); i++) {
    results.push({
      title: titles[i].title,
      snippet: snippets[i],
      url: titles[i].url,
    });
  }

  if (results.length === 0) {
    return `No results found for: ${query}`;
  }

  return results
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}

export async function executeTool(name: string, argsJson: string, mode: AgentMode = "agent"): Promise<string> {
  let args: any;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return `Error: invalid JSON arguments: ${argsJson}`;
  }

  const accessError = validateToolAccess(mode, name, args);
  if (accessError) {
    return accessError;
  }

  try {
    switch (name) {
      case "read_file": {
        const p = resolveSafe(args.path);
        const content = await fs.readFile(p, "utf-8");
        if (args.start_line || args.end_line) {
          const lines = content.split("\n");
          const start = (args.start_line ?? 1) - 1;
          const end = args.end_line ?? lines.length;
          return truncateResult(
            lines
              .slice(start, end)
              .map((l, i) => `${start + i + 1}: ${l}`)
              .join("\n"),
            name
          );
        }
        return truncateResult(
          content
            .split("\n")
            .map((l, i) => `${i + 1}: ${l}`)
            .join("\n"),
          name
        );
      }

      case "write_file": {
        const p = resolveSafe(args.path);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, args.content, "utf-8");
        log("tool", `wrote ${args.path} (${args.content.length} bytes)`);
        return `File written: ${path.basename(args.path)}`;
      }

      case "edit_file": {
        const p = resolveSafe(args.path);
        const original = await fs.readFile(p, "utf-8");
        const occurrences = original.split(args.old_text).length - 1;
        if (occurrences === 0) {
          return `Error: old_text not found in ${args.path}`;
        }
        if (occurrences > 1) {
          return `Error: old_text matches ${occurrences} times in ${args.path}; must be unique. Add more context.`;
        }
        const updated = original.replace(args.old_text, args.new_text);
        await fs.writeFile(p, updated, "utf-8");
        const patch = createTwoFilesPatch(args.path, args.path, original, updated, "", "");
        log("tool", `edited ${args.path}`);
        log("diff", patch);
        return `Edit applied to ${args.path}.\nDiff:\n${patch}`;
      }

      case "list_dir": {
        const dir = resolveSafe(args.path ?? ".");
        if (args.recursive) {
          const { stdout } = await execAsync(`find "${dir}" -not -path '*/node_modules/*' -not -path '*/.git/*'`);
          return truncateResult(stdout, name);
        }
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return truncateResult(entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n"), name);
      }

      case "search_files": {
        const dir = resolveSafe(args.path ?? ".");
        const { stdout } = await execAsync(
          `grep -rn --exclude-dir=node_modules --exclude-dir=.git ${JSON.stringify(args.pattern)} "${dir}" || true`
        );
        return truncateResult(stdout || "(no matches)", name);
      }

      case "read_file_outline": {
        const p = resolveSafe(args.path);
        const content = await fs.readFile(p, "utf-8");
        const lines = content.split("\n");
        const ext = path.extname(args.path).toLowerCase();

        // Patterns that indicate a meaningful declaration line worth surfacing
        const patterns: RegExp[] = [
          // TypeScript / JavaScript
          /^\s*(export\s+)?(async\s+)?function\s+\w+/,
          /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+/,
          /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/,
          /^\s*(export\s+)?(const|let|var)\s+\w+\s*:\s*\w+/,
          /^\s*(public|private|protected|static|async|readonly).*\w+\s*[(<]/,
          /^\s*(export\s+)?interface\s+\w+/,
          /^\s*(export\s+)?type\s+\w+\s*=/,
          /^\s*(export\s+)?enum\s+\w+/,
          // Python
          /^\s*def\s+\w+/,
          /^\s*class\s+\w+/,
          /^\s*async\s+def\s+\w+/,
          // Rust
          /^\s*(pub\s+)?(async\s+)?fn\s+\w+/,
          /^\s*(pub\s+)?struct\s+\w+/,
          /^\s*(pub\s+)?enum\s+\w+/,
          /^\s*(pub\s+)?trait\s+\w+/,
          /^\s*(pub\s+)?impl(\s+\w+)?\s+/,
          // Go
          /^\s*func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/,
          /^\s*type\s+\w+\s+(struct|interface)/,
        ];

        const outline: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (patterns.some((re) => re.test(line))) {
            // Trim trailing { or : and whitespace for compactness
            const trimmed = line.replace(/\s*[{:]\s*$/, "").trimEnd();
            outline.push(`${i + 1}: ${trimmed}`);
          }
        }

        if (outline.length === 0) {
          return `No recognizable declarations found in ${args.path}. Use read_file to read it directly.`;
        }

        return `Outline of ${args.path} (${lines.length} lines total):\n${outline.join("\n")}`;
      }

      case "run_shell_command": {
        log("tool", `$ ${args.command}`);
        const { stdout, stderr } = await execAsync(args.command, { cwd: CWD, timeout: 60_000 });
        return truncateResult(`stdout:\n${stdout}\nstderr:\n${stderr}`, name);
      }

      case "get_file_content": {
        const p = resolveSafe(args.path);
        const content = await fs.readFile(p, args.encoding || "utf-8");
        // Ensure content is always a string (fs.readFile can return NonSharedBuffer)
        const strContent = typeof content === "string" ? content : content.toString();
        return truncateResult(strContent, name);
      }

      case "get_file_size": {
        const p = resolveSafe(args.path);
        const stats = await fs.stat(p);
        return `Size: ${stats.size} bytes`;
      }

      case "get_file_lines": {
        const p = resolveSafe(args.path);
        const content = await fs.readFile(p, "utf-8");
        const lines = content.split("\n");
        // Remove empty last line if file doesn't end with newline
        return `Lines: ${lines.length - (lines[lines.length - 1] === "" ? 1 : 0)}`;
      }

      case "web_search": {
        const numResults = Math.min(Math.max(args.num_results ?? 5, 1), 10);
        log("tool", `searching: ${args.query}`);
        const searchResults = await scrapeDuckDuckGo(args.query, numResults);
        return truncateResult(searchResults, name);
      }

      default:
        return `Error: unknown tool ${name}`;
    }
  } catch (err: any) {
    return `Error executing ${name}: ${err.message}`;
  }
}
