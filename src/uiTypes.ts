export type LogEntryKind = "user" | "assistant" | "info" | "error" | "tool" | "diff";

export type AgentMode = "agent" | "chat";

export const MODE_ORDER: AgentMode[] = ["agent", "chat"];

export function nextMode(mode: AgentMode): AgentMode {
  const idx = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
}

export interface LogEntry {
  id: string;
  kind: LogEntryKind;
  text: string;
}

let counter = 0;
export function nextId(): string {
  counter += 1;
  return `entry_${counter}_${Date.now()}`;
}
