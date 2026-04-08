import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { runChatgptAppsMcpBridgeStdio } from "./mcp-bridge.js";
import { resolveOpenaiAppsRuntimeEnv } from "./runtime-env.js";

function writeDebugLog(env: NodeJS.ProcessEnv, message: string): void {
  if (env.OPENCLAW_OPENAI_APPS_DEBUG !== "1") {
    return;
  }
  process.stderr.write(`[openai-apps] ${message}\n`);
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
  const runtimeEnv = await resolveOpenaiAppsRuntimeEnv(process.env);
  writeDebugLog(runtimeEnv, "server main start");
  const config = await loadRawConfig(runtimeEnv);
  writeDebugLog(runtimeEnv, "config loaded");
  await runChatgptAppsMcpBridgeStdio({
    loadOpenClawConfig: () => config,
    env: runtimeEnv,
  });
  writeDebugLog(runtimeEnv, "bridge connected");
}

void main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
