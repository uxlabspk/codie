import React from "react";
import { Box, Text } from "ink";

const MAX_PREVIEW_LINES = 20;

export function StreamingPreview({ text }: { text: string }) {
  if (!text) return null;
  const lines = text.split("\n");
  const visible = lines.length > MAX_PREVIEW_LINES ? lines.slice(-MAX_PREVIEW_LINES) : lines;
  const truncated = lines.length > MAX_PREVIEW_LINES;

  return (
    <Box flexDirection="column">
      <Text bold color="blue">
        assistant›
      </Text>
      {truncated && <Text dimColor>... ({lines.length - MAX_PREVIEW_LINES} lines above)</Text>}
      <Text>{visible.join("\n")}</Text>
    </Box>
  );
}
