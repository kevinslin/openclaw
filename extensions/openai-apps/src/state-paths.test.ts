import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHATGPT_APPS_RUNTIME_ID, resolveChatgptAppsStatePaths } from "./state-paths.js";

describe("resolveChatgptAppsStatePaths", () => {
  it("roots the bundle cache under OPENCLAW_STATE_DIR", () => {
    const paths = resolveChatgptAppsStatePaths({
      OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
      HOME: "/tmp/home",
    });

    expect(paths.rootDir).toBe(
      path.join("/tmp/openclaw-state", "plugin-runtimes", CHATGPT_APPS_RUNTIME_ID),
    );
    expect(paths.snapshotPath).toBe(path.join(paths.rootDir, "connectors.snapshot.json"));
    expect(paths.derivedConfigPath).toBe(path.join(paths.rootDir, "codex-apps.config.json"));
    expect(paths.refreshDebugPath).toBe(path.join(paths.rootDir, "refresh-debug.json"));
  });

  it("falls back to the owning agent state root when OPENCLAW_STATE_DIR is unset", () => {
    const paths = resolveChatgptAppsStatePaths({
      OPENCLAW_AGENT_DIR: "/tmp/openclaw-dev/agents/dev/agent",
      HOME: "/tmp/home",
    });

    expect(paths.rootDir).toBe(
      path.join("/tmp/openclaw-dev", "plugin-runtimes", CHATGPT_APPS_RUNTIME_ID),
    );
  });
});
