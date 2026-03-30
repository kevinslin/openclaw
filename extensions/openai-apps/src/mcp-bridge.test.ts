import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
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

function createPersistedSnapshot(): PersistedConnectorSnapshot {
  return {
    version: 1,
    fetchedAt: "2026-03-29T18:00:00.000Z",
    projectedAt: "2026-03-29T18:00:00.000Z",
    accountId: "acct_123",
    authIdentityKey: "user@example.com",
    configHash: "config-hash",
    baseUrlHash: "base-hash",
    inventory: [
      {
        id: "slack",
        name: "Slack",
        description: "Chat with Slack workspaces.",
        logoUrl: null,
        logoUrlDark: null,
        distributionChannel: null,
        branding: null,
        appMetadata: null,
        labels: null,
        installUrl: null,
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: ["Slack"],
      },
    ],
    statuses: [
      {
        name: "slack",
        tools: {
          slack_send: {
            name: "slack_send",
            description: "Send to Slack",
            inputSchema: {
              type: "object",
              properties: {
                text: {
                  type: "string",
                },
              },
              required: ["text"],
            },
          },
        },
        resources: [],
        resourceTemplates: [],
        authStatus: "oAuth",
      },
    ],
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
  it("publishes one connector-level tool per enabled app", async () => {
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
          description: expect.stringContaining("request field"),
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
    snapshot.inventory.push({
      id: "collab",
      name: "Collab",
      description: null,
      logoUrl: null,
      logoUrlDark: null,
      distributionChannel: null,
      branding: null,
      appMetadata: null,
      labels: null,
      installUrl: null,
      isAccessible: true,
      isEnabled: true,
      pluginDisplayNames: ["Collab"],
    });
    snapshot.statuses.push({
      name: "collab",
      tools: {
        collab_send_message: {
          name: "collab_send_message",
          description: "Internal collab dispatch",
          inputSchema: { type: "object" },
        },
      },
      resources: [],
      resourceTemplates: [],
      authStatus: "oAuth",
    });
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

  it("publishes connector tools from inventory even when mcpServerStatus/list data is missing", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.statuses = [];
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
      await expect(bridge.listTools()).resolves.toEqual([
        expect.objectContaining({
          name: "chatgpt_app_slack",
        }),
      ]);
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
    snapshot.inventory.push({
      id: "gmail",
      name: "Gmail",
      description: "Read mail.",
      logoUrl: null,
      logoUrlDark: null,
      distributionChannel: null,
      branding: null,
      appMetadata: null,
      labels: null,
      installUrl: null,
      isAccessible: true,
      isEnabled: true,
      pluginDisplayNames: ["Gmail"],
    });
    snapshot.statuses.push({
      name: "gmail",
      tools: {
        gmail_search_emails: {
          name: "gmail_search_emails",
          description: "Search email",
          inputSchema: { type: "object" },
        },
      },
      resources: [],
      resourceTemplates: [],
      authStatus: "oAuth",
    });
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
