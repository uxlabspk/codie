import React from "react";
import { Box, Text } from "ink";
import type { AgentMode } from "./uiTypes.js";

export interface UsageInfo {
  used: number;
  budget: number;
  ctxSize: number;
  pct: number;
}

export function StatusBar({ cwd, usage, mode }: { cwd: string; usage: UsageInfo; mode: AgentMode }) {
  const color = usage.pct >= 85 ? "red" : usage.pct >= 60 ? "yellow" : "green";
  return (
    <Box justifyContent="space-between">
      <Text dimColor>
        {cwd} | mode: {mode}
      </Text>
      <Text color={color}>
        {usage.used}/{usage.budget} tokens ({usage.pct}%)
      </Text>
    </Box>
  );
}
