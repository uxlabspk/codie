import React, { useState, useRef } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface InputBarProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputBar({ onSubmit, disabled, placeholder }: InputBarProps) {
  const [value, setValue] = useState("");
  const historyRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 = not browsing history
  const draftRef = useRef("");

  // Arrow-key history navigation. TextInput handles left/right/typing itself;
  // we only need to intercept up/down, which TextInput doesn't use internally.
  useInput(
    (_input, key) => {
      if (disabled) return;
      const history = historyRef.current;
      if (history.length === 0) return;

      if (key.upArrow) {
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
      } else if (key.downArrow) {
        if (historyIndex === -1) return;
        const idx = historyIndex + 1;
        if (idx >= history.length) {
          setHistoryIndex(-1);
          setValue(draftRef.current);
        } else {
          setHistoryIndex(idx);
          setValue(history[idx]);
        }
      }
    },
    { isActive: !disabled }
  );

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    setValue("");
    setHistoryIndex(-1);
    draftRef.current = "";
    if (trimmed) {
      historyRef.current.push(trimmed);
      onSubmit(trimmed);
    }
  };

  return (
    <Box borderStyle="round" borderColor={disabled ? "gray" : "green"} paddingX={1}>
      <Text color="green">{"› "}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={placeholder}
        focus={!disabled}
      />
    </Box>
  );
}
