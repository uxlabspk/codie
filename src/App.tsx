import React, { useState, useCallback, useRef } from "react";
import { Box, Static, useApp } from "ink";
import { LogLine } from "./LogLine.js";
import { InputBar } from "./InputBar.js";
import { StatusBar, type UsageInfo } from "./StatusBar.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { StreamingPreview } from "./StreamingPreview.js";
import type { LogEntry } from "./uiTypes.js";
import { nextId } from "./uiTypes.js";

export interface AppHandle {
  addEntry: (kind: LogEntry["kind"], text: string) => void;
  setUsage: (u: UsageInfo) => void;
  setBusy: (busy: boolean, label?: string) => void;
  setStreamingText: (text: string | null) => void;
}

interface AppProps {
  cwd: string;
  initialUsage: UsageInfo;
  onUserInput: (text: string) => void;
  onReady: (handle: AppHandle) => void;
}

export function App({ cwd, initialUsage, onUserInput, onReady }: AppProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [usage, setUsage] = useState<UsageInfo>(initialUsage);
  const [busy, setBusyState] = useState(false);
  const [busyLabel, setBusyLabel] = useState("thinking");
  const [streamingText, setStreamingTextState] = useState<string | null>(null);
  const readyFired = useRef(false);

  const addEntry = useCallback((kind: LogEntry["kind"], text: string) => {
    setEntries((prev) => [...prev, { id: nextId(), kind, text }]);
  }, []);

  const setBusy = useCallback((b: boolean, label?: string) => {
    setBusyState(b);
    if (label) setBusyLabel(label);
    if (!b) setStreamingTextState(null);
  }, []);

  const setStreamingText = useCallback((text: string | null) => {
    setStreamingTextState(text);
  }, []);

  if (!readyFired.current) {
    readyFired.current = true;
    // Defer to next tick so setState calls from the handle don't fire during render.
    setTimeout(() => {
      onReady({ addEntry, setUsage, setBusy, setStreamingText });
    }, 0);
  }

  const handleSubmit = useCallback(
    (text: string) => {
      onUserInput(text);
    },
    [onUserInput]
  );

  return (
    <Box flexDirection="column">
      <Static items={entries}>{(entry) => <LogLine key={entry.id} entry={entry} />}</Static>

      {busy && !streamingText && (
        <Box marginBottom={1}>
          <ThinkingIndicator label={busyLabel} />
        </Box>
      )}

      {streamingText !== null && (
        <Box marginBottom={1}>
          <StreamingPreview text={streamingText} />
        </Box>
      )}

      <InputBar onSubmit={handleSubmit} disabled={busy} placeholder="Type your message..." />
      <StatusBar cwd={cwd} usage={usage} />
    </Box>
  );
}
