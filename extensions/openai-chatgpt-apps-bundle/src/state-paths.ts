import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export const CHATGPT_APPS_RUNTIME_ID = "openai-chatgpt-apps";

export type ChatgptAppsStatePaths = {
  rootDir: string;
  codexHomeDir: string;
  snapshotPath: string;
  derivedConfigPath: string;
  refreshDebugPath: string;
};

export function resolveChatgptAppsStatePaths(
  env: NodeJS.ProcessEnv = process.env,
): ChatgptAppsStatePaths {
  const rootDir = path.join(resolveStateDir(env), "plugin-runtimes", CHATGPT_APPS_RUNTIME_ID);
  return {
    rootDir,
    codexHomeDir: path.join(rootDir, "codex-home"),
    snapshotPath: path.join(rootDir, "connectors.snapshot.json"),
    derivedConfigPath: path.join(rootDir, "codex-apps.config.json"),
    refreshDebugPath: path.join(rootDir, "refresh-debug.json"),
  };
}
