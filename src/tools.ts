import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ToolDef } from "./llamaClient.js";

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
];

export async function executeTool(name: string, argsJson: string): Promise<string> {
  let args: any;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return `Error: invalid JSON arguments: ${argsJson}`;
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
          return lines
            .slice(start, end)
            .map((l, i) => `${start + i + 1}: ${l}`)
            .join("\n");
        }
        return content
          .split("\n")
          .map((l, i) => `${i + 1}: ${l}`)
          .join("\n");
      }

      case "write_file": {
        const p = resolveSafe(args.path);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, args.content, "utf-8");
        log("tool", `wrote ${args.path} (${args.content.length} bytes)`);
        return `File written: ${args.path}`;
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
          return stdout;
        }
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
      }

      case "search_files": {
        const dir = resolveSafe(args.path ?? ".");
        const { stdout } = await execAsync(
          `grep -rn --exclude-dir=node_modules --exclude-dir=.git ${JSON.stringify(args.pattern)} "${dir}" || true`
        );
        return stdout || "(no matches)";
      }

      case "run_shell_command": {
        log("tool", `$ ${args.command}`);
        const { stdout, stderr } = await execAsync(args.command, { cwd: CWD, timeout: 60_000 });
        return `stdout:\n${stdout}\nstderr:\n${stderr}`;
      }

      default:
        return `Error: unknown tool ${name}`;
    }
  } catch (err: any) {
    return `Error executing ${name}: ${err.message}`;
  }
}
