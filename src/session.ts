import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ChatMessage } from "./llamaClient.js";

const SESSION_DIR = path.join(os.homedir(), ".codie", "sessions");

export async function ensureSessionDir() {
  await fs.mkdir(SESSION_DIR, { recursive: true });
}

export async function saveSession(name: string, history: ChatMessage[]) {
  await ensureSessionDir();
  const file = path.join(SESSION_DIR, `${name}.json`);
  await fs.writeFile(file, JSON.stringify({ savedAt: new Date().toISOString(), history }, null, 2));
  return file;
}

export async function loadSession(name: string): Promise<ChatMessage[] | null> {
  const file = path.join(SESSION_DIR, `${name}.json`);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const data = JSON.parse(raw);
    return data.history as ChatMessage[];
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<string[]> {
  await ensureSessionDir();
  const files = await fs.readdir(SESSION_DIR);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}
