import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export const CHATGPT_APPS_RUNTIME_ID = "openai-apps";

export type ChatgptAppsStatePaths = {
  rootDir: string;
  codexHomeDir: string;
  snapshotPath: string;
  derivedConfigPath: string;
  refreshDebugPath: string;
};

function resolveBundleStateDir(env: NodeJS.ProcessEnv): string {
  if (typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.trim().length > 0) {
    return resolveStateDir(env);
  }

  const agentDir = env.OPENCLAW_AGENT_DIR?.trim();
  if (agentDir) {
    const normalizedAgentDir = path.normalize(agentDir);
    const agentSuffix = `${path.sep}agents${path.sep}`;
    const agentsIndex = normalizedAgentDir.lastIndexOf(agentSuffix);
    if (agentsIndex > 0) {
      return normalizedAgentDir.slice(0, agentsIndex);
    }
  }

  return resolveStateDir(env);
}

export function resolveChatgptAppsStatePaths(
  env: NodeJS.ProcessEnv = process.env,
): ChatgptAppsStatePaths {
  const rootDir = path.join(resolveBundleStateDir(env), "plugin-runtimes", CHATGPT_APPS_RUNTIME_ID);
  return {
    rootDir,
    codexHomeDir: path.join(rootDir, "codex-home"),
    snapshotPath: path.join(rootDir, "connectors.snapshot.json"),
    derivedConfigPath: path.join(rootDir, "codex-apps.config.json"),
    refreshDebugPath: path.join(rootDir, "refresh-debug.json"),
  };
}
