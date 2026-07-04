import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export function ThinkingIndicator({ label = "thinking" }: { label?: string }) {
  return (
    <Box>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text color="cyan"> {label}...</Text>
    </Box>
  );
}
