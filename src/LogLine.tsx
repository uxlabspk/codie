import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "./uiTypes.js";
import { renderMarkdown } from "./markdown.js";

export function LogLine({ entry }: { entry: LogEntry }) {
  switch (entry.kind) {
    case "user":
      return (
        <Box marginBottom={1}>
          <Text bold color="green">
            you›{" "}
          </Text>
          <Text>{entry.text}</Text>
        </Box>
      );

    case "assistant": {
      const rendered = renderMarkdown(entry.text);
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="blue">
            assistant›
          </Text>
          <Text>{rendered}</Text>
        </Box>
      );
    }

    case "info":
      return (
        <Box>
          <Text dimColor>{entry.text}</Text>
        </Box>
      );

    case "error":
      return (
        <Box>
          <Text color="red">{entry.text}</Text>
        </Box>
      );

    case "tool":
      return (
        <Box>
          <Text color="yellow" dimColor>
            {entry.text}
          </Text>
        </Box>
      );

    case "diff":
      return (
        <Box flexDirection="column" marginBottom={1}>
          {entry.text.split("\n").map((line, i) => (
            <Text
              key={i}
              color={line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined}
              dimColor={line.startsWith("@@") || line.startsWith("Index:") || line.startsWith("===")}
            >
              {line}
            </Text>
          ))}
        </Box>
      );

    default:
      return (
        <Box>
          <Text>{entry.text}</Text>
        </Box>
      );
  }
}
