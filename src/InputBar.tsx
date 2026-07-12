import React, { useState, useRef } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AgentMode } from "./uiTypes.js";

const SLASH_COMMANDS = [
  { name: "/usage", desc: "Show token usage vs. budget" },
  { name: "/compact", desc: "Force compaction now" },
  { name: "/memory", desc: "Show session memory file (info.md)" },
  { name: "/save", desc: "Save session to disk" },
  { name: "/sessions", desc: "List saved sessions" },
  { name: "/clear", desc: "Wipe history (keeps system prompt)" },
  { name: "/mode", desc: "Show or set mode: /mode <agent|chat|plan>" },
  { name: "/design", desc: "Design a project: /design <description>" },
  { name: "/exit", desc: "Save and quit" },
];

interface InputBarProps {
  onSubmit: (text: string) => void;
  mode: AgentMode;
  onCycleMode: () => void;
  disabled?: boolean;
  placeholder?: string;
}

const MODE_COLORS: Record<AgentMode, "green" | "blue" | "yellow"> = {
  agent: "green",
  chat: "blue",
  plan: "yellow",
};

export function InputBar({ onSubmit, mode, onCycleMode, disabled, placeholder }: InputBarProps) {
  const [value, setValue] = useState("");
  const [tokenCount, setTokenCount] = useState(0);
  const historyRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const draftRef = useRef("");
  const [suggestionIndex, setSuggestionIndex] = useState(0);

  // Compute suggestions whenever the value starts with "/"
  const suggestions =
    value.startsWith("/")
      ? SLASH_COMMANDS.filter((c) => c.name.startsWith(value.toLowerCase()))
      : [];

  const hasSuggestions = suggestions.length > 0;
  // Keep suggestionIndex in range whenever suggestions change
  const clampedSuggestionIndex = hasSuggestions
    ? Math.min(suggestionIndex, suggestions.length - 1)
    : 0;

  useInput(
    (input, key) => {
      if (disabled) return;

      if (key.ctrl && (key.upArrow || key.downArrow)) {
        onCycleMode();
        return;
      }

      // Tab or right-arrow at end of input → accept highlighted suggestion
      if (key.tab || (key.rightArrow && value === value)) {
        if (hasSuggestions) {
          const accepted = suggestions[clampedSuggestionIndex].name;
          setValue(accepted);
          setSuggestionIndex(0);
          return;
        }
      }

      // Up/down navigate suggestions when visible, else walk history
      if (key.upArrow) {
        if (hasSuggestions) {
          setSuggestionIndex((i) => Math.max(0, i - 1));
          return;
        }
        const history = historyRef.current;
        if (history.length === 0) return;
        if (historyIndex === -1) {
          draftRef.current = value;
          const idx = history.length - 1;
          setHistoryIndex(idx);
          setValue(history[idx]);
        } else if (historyIndex > 0) {
          const idx = historyIndex - 1;
          setHistoryIndex(idx);
          setValue(history[idx]);
        }
        return;
      }

      if (key.downArrow) {
        if (hasSuggestions) {
          setSuggestionIndex((i) => Math.min(suggestions.length - 1, i + 1));
          return;
        }
        if (historyIndex === -1) return;
        const history = historyRef.current;
        const idx = historyIndex + 1;
        if (idx >= history.length) {
          setHistoryIndex(-1);
          setValue(draftRef.current);
        } else {
          setHistoryIndex(idx);
          setValue(history[idx]);
        }
        return;
      }

      // Escape clears suggestions without clearing input
      if (key.escape) {
        setSuggestionIndex(0);
        return;
      }
    },
    { isActive: !disabled }
  );

  const calculateTokenCount = (text: string): number => {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  };

  const handleChange = (newVal: string) => {
    setValue(newVal);
    setTokenCount(calculateTokenCount(newVal));
    setSuggestionIndex(0); // reset highlight when user types
    // Reset history browsing when they start typing freely
    if (historyIndex !== -1) {
      setHistoryIndex(-1);
      draftRef.current = "";
    }
  };

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    setValue("");
    setHistoryIndex(-1);
    setSuggestionIndex(0);
    draftRef.current = "";
    if (trimmed) {
      historyRef.current.push(trimmed);
      onSubmit(trimmed);
    }
  };

  const accent = MODE_COLORS[mode];

  return (
    <Box flexDirection="column">
      {/* Autocomplete dropdown — rendered above the input */}
      {hasSuggestions && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          marginBottom={0}
        >
          {suggestions.map((cmd, i) => {
            const highlighted = i === clampedSuggestionIndex;
            return (
              <Box key={cmd.name}>
                <Text
                  color={highlighted ? "black" : "cyan"}
                  backgroundColor={highlighted ? "cyan" : undefined}
                  bold={highlighted}
                >
                  {cmd.name.padEnd(12)}
                </Text>
                <Text color={highlighted ? "black" : "gray"} backgroundColor={highlighted ? "cyan" : undefined}>
                  {" " + cmd.desc}
                </Text>
              </Box>
            );
          })}
          <Text dimColor>tab/→ accept  ↑↓ select  esc dismiss</Text>
        </Box>
      )}

      <Box borderStyle="round" borderColor={disabled ? "gray" : accent} paddingX={1}>
        <Text color={accent}>{"› "}</Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder={placeholder}
          focus={!disabled}
        />
        <Box marginLeft={2}>
          <Text dimColor color="gray">
            {tokenCount} tokens
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

