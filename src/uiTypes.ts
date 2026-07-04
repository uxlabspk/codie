export type LogEntryKind = "user" | "assistant" | "info" | "error" | "tool" | "diff";

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
