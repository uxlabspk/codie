import React from "react";
import { Box, Text } from "ink";

export interface UsageInfo {
  used: number;
  budget: number;
  ctxSize: number;
  pct: number;
}

export function StatusBar({ cwd, usage }: { cwd: string; usage: UsageInfo }) {
  const color = usage.pct >= 85 ? "red" : usage.pct >= 60 ? "yellow" : "green";
  return (
    <Box justifyContent="space-between">
      <Text dimColor>{cwd}</Text>
      <Text color={color}>
        {usage.used}/{usage.budget} tokens ({usage.pct}%)
      </Text>
    </Box>
  );
}
