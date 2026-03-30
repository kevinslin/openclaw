import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import type { PersistedConnectorRecord } from "./connector-record.js";
import { ChatgptAppsMcpBridge } from "./mcp-bridge.js";
import type { PersistedConnectorSnapshot } from "./snapshot-cache.js";
import { resolveChatgptAppsStatePaths } from "./state-paths.js";

function createConfig(
  connectors: Record<string, { enabled: boolean }> = { slack: { enabled: true } },
): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "openai-apps": {
          config: {
            enabled: true,
            connectors,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createConnectorRecord(
  overrides: Partial<PersistedConnectorRecord> = {},
): PersistedConnectorRecord {
  return {
    connectorId: "slack",
    appId: "asdk_app_slack",
    appName: "Slack",
    publishedName: "chatgpt_app_slack",
    appInvocationToken: "slack",
    description: "Chat with Slack workspaces.",
    pluginDisplayNames: ["Slack"],
    isAccessible: true,
    isEnabled: true,
    ...overrides,
  };
}

function createPersistedSnapshot(): PersistedConnectorSnapshot {
  return {
    version: 2,
    fetchedAt: "2026-03-29T18:00:00.000Z",
    projectedAt: "2026-03-29T18:00:00.000Z",
    accountId: "acct_123",
    authIdentityKey: "user@example.com",
    configHash: "config-hash",
    baseUrlHash: "base-hash",
    connectors: [createConnectorRecord()],
  };
}

async function writeSnapshot(stateDir: string, snapshot = createPersistedSnapshot()) {
  const statePaths = resolveChatgptAppsStatePaths({
    OPENCLAW_STATE_DIR: stateDir,
    HOME: os.tmpdir(),
  });
  await mkdir(path.dirname(statePaths.snapshotPath), { recursive: true });
  await writeFile(statePaths.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function createStateDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "openai-apps-bridge-"));
}

describe("ChatgptAppsMcpBridge", () => {
  it("publishes one connector-level tool per enabled connector record", async () => {
    const stateDir = await createStateDir();
    await writeSnapshot(stateDir);
    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot: createPersistedSnapshot(),
        config: {
          enabled: true,
          appServer: { command: "codex", args: [] },
          linking: {
            enabled: false,
            waitTimeoutMs: 60_000,
            pollIntervalMs: 3_000,
          },
          connectors: { slack: { enabled: true } },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
    });

    try {
      await expect(bridge.listTools()).resolves.toEqual([
        expect.objectContaining({
          name: "chatgpt_app_slack",
          description: expect.not.stringContaining("server-side capability"),
          inputSchema: expect.objectContaining({
            required: ["request"],
          }),
        }),
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("does not publish internal collab apps under wildcard enablement", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.connectors.push(
      createConnectorRecord({
        connectorId: "collab",
        appId: "collab",
        appName: "Collab",
        publishedName: "chatgpt_app_collab",
        appInvocationToken: "collab",
        description: "Internal collab dispatch.",
        pluginDisplayNames: ["Collab"],
      }),
    );
    await writeSnapshot(stateDir, snapshot);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig({ "*": { enabled: true } }),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          enabled: true,
          appServer: { command: "codex", args: [] },
          linking: {
            enabled: false,
            waitTimeoutMs: 60_000,
            pollIntervalMs: 3_000,
          },
          connectors: { "*": { enabled: true } },
        },
        openclawConfig: createConfig({ "*": { enabled: true } }),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
    });

    try {
      const tools = await bridge.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["chatgpt_app_slack"]);
    } finally {
      await bridge.close();
    }
  });

  it("fails publication when a connector snapshot record is malformed", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.connectors = [
      createConnectorRecord({
        publishedName: "not-the-published-name",
      }),
    ];
    await writeSnapshot(stateDir, snapshot);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          enabled: true,
          appServer: { command: "codex", args: [] },
          linking: {
            enabled: false,
            waitTimeoutMs: 60_000,
            pollIntervalMs: 3_000,
          },
          connectors: { slack: { enabled: true } },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
    });

    try {
      await expect(bridge.listTools()).rejects.toThrow("mismatched publishedName");
    } finally {
      await bridge.close();
    }
  });

  it("fails publication when the snapshot contains duplicate connector ids", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.connectors.push(
      createConnectorRecord({
        appId: "asdk_app_slack_2",
      }),
    );
    await writeSnapshot(stateDir, snapshot);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig({ "*": { enabled: true } }),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          enabled: true,
          appServer: { command: "codex", args: [] },
          linking: {
            enabled: false,
            waitTimeoutMs: 60_000,
            pollIntervalMs: 3_000,
          },
          connectors: { "*": { enabled: true } },
        },
        openclawConfig: createConfig({ "*": { enabled: true } }),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
    });

    try {
      await expect(bridge.listTools()).rejects.toThrow(
        "Duplicate connector snapshot record for connector: slack",
      );
    } finally {
      await bridge.close();
    }
  });

  it("routes connector tools through the app-server invoker", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    await writeSnapshot(stateDir, snapshot);
    const appServerInvoker = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          enabled: true,
          appServer: { command: "codex", args: [] },
          linking: {
            enabled: false,
            waitTimeoutMs: 60_000,
            pollIntervalMs: 3_000,
          },
          connectors: { slack: { enabled: true } },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      appServerInvoker,
    });

    try {
      const result = await bridge.callTool("chatgpt_app_slack", {
        request: "Send a launch update to #team",
      });

      expect(result).toEqual({
        content: [{ type: "text", text: "ok" }],
      });
      expect(appServerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({
          route: {
            connectorId: "slack",
            appId: "asdk_app_slack",
            publishedName: "chatgpt_app_slack",
            appName: "Slack",
            appInvocationToken: "slack",
          },
          args: {
            request: "Send a launch update to #team",
          },
        }),
      );
    } finally {
      await bridge.close();
    }
  });

  it("honors wildcard enablement with explicit disables", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.connectors.push(
      createConnectorRecord({
        connectorId: "gmail",
        appId: "asdk_app_gmail",
        appName: "Gmail",
        publishedName: "chatgpt_app_gmail",
        appInvocationToken: "gmail",
        description: "Read mail.",
        pluginDisplayNames: ["Gmail"],
      }),
    );
    await writeSnapshot(stateDir, snapshot);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () =>
        createConfig({
          "*": { enabled: true },
          gmail: { enabled: false },
        }),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          enabled: true,
          appServer: { command: "codex", args: [] },
          linking: {
            enabled: false,
            waitTimeoutMs: 60_000,
            pollIntervalMs: 3_000,
          },
          connectors: {
            "*": { enabled: true },
            gmail: { enabled: false },
          },
        },
        openclawConfig: createConfig({
          "*": { enabled: true },
          gmail: { enabled: false },
        }),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
    });

    try {
      const tools = await bridge.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["chatgpt_app_slack"]);
    } finally {
      await bridge.close();
    }
  });
});
