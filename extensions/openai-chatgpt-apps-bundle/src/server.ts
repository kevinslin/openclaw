import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { runChatgptAppsMcpBridgeStdio } from "./mcp-bridge.js";

function hasHardRefreshFlag(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes("--hard-refresh") || env.OPENCLAW_CHATGPT_APPS_HARD_REFRESH === "1";
}

function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  const explicitPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const stateDir =
    env.OPENCLAW_STATE_DIR?.trim() || path.join(env.HOME || os.homedir(), ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

async function loadRawConfig(env: NodeJS.ProcessEnv): Promise<OpenClawConfig> {
  const configPath = resolveConfigPath(env);
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as OpenClawConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {} as OpenClawConfig;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = await loadRawConfig(process.env);
  await runChatgptAppsMcpBridgeStdio({
    loadOpenClawConfig: () => config,
    env: process.env,
    hardRefresh: hasHardRefreshFlag(process.argv.slice(2), process.env),
  });
}

void main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
