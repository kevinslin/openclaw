import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
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
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
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
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
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
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
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
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
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
          handleMcpServerElicitation: expect.any(Function),
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

  it("shares the same apps config write gate across refresh and tool invocation", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    await writeSnapshot(stateDir, snapshot);

    let refreshGate: unknown = null;
    let invokeGate: unknown = null;
    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      ensureFreshSnapshot: async (params) => {
        refreshGate = params.appsConfigWriteGate;
        return {
          status: "ok",
          source: "cache",
          snapshot,
          config: {
            enabled: true,
            allowDestructiveActions: "never",
            appServer: { command: "codex", args: [] },
            connectors: { slack: { enabled: true } },
          },
          openclawConfig: createConfig(),
          statePaths: resolveChatgptAppsStatePaths({
            OPENCLAW_STATE_DIR: stateDir,
            HOME: os.tmpdir(),
          }),
        };
      },
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      appServerInvoker: vi.fn(async (params) => {
        invokeGate = params.appsConfigWriteGate;
        return {
          content: [{ type: "text" as const, text: "ok" }],
        };
      }),
    });

    try {
      await bridge.listTools();
      await bridge.callTool("chatgpt_app_slack", {
        request: "Send a launch update to #team",
      });

      expect(refreshGate).toBeTruthy();
      expect(invokeGate).toBe(refreshGate);
    } finally {
      await bridge.close();
    }
  });

  it("prompts MCP clients for destructive actions when configured for on-request", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    await writeSnapshot(stateDir, snapshot);

    const appServerInvoker = vi.fn(async (params) => {
      const response = await params.handleMcpServerElicitation?.({
        threadId: "thr_123",
        turnId: "turn_123",
        serverName: "codex_apps",
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_name: "Slack",
          tool_title: "post_message",
          tool_params: {
            channel: "#launch",
            text: "Ship it",
          },
        },
        message: "Allow Slack to post a message?",
        requestedSchema: {
          type: "object",
          properties: {},
        },
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    });

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
          allowDestructiveActions: "on-request",
          appServer: { command: "codex", args: [] },
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

    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
    const elicitationRequests: unknown[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitationRequests.push(request.params);
      return {
        action: "accept",
        content: {},
      };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "chatgpt_app_slack",
        arguments: {
          request: "Send a launch update to #launch",
        },
      });

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action: "accept",
              content: {},
              _meta: null,
            }),
          },
        ],
      });
      expect(elicitationRequests).toEqual([
        expect.objectContaining({
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: {},
          },
        }),
      ]);
      const prompt = elicitationRequests[0] as { message: string };
      expect(prompt.message).toContain("The Slack app requested approval for post_message.");
      expect(prompt.message).toContain("Allow Slack to post a message?");
      expect(prompt.message).toContain("App payload:");
      expect(prompt.message).toContain('"channel": "#launch"');
      expect(prompt.message).toContain('"text": "Ship it"');
      expect(prompt.message).toContain(
        "Choose accept to continue or decline to reject the action.",
      );
    } finally {
      await Promise.all([client.close(), bridge.close()]);
    }
  });

  it("maps declined MCP approvals back to the app-server decline payload", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    await writeSnapshot(stateDir, snapshot);

    const appServerInvoker = vi.fn(async (params) => {
      const response = await params.handleMcpServerElicitation?.({
        threadId: "thr_123",
        turnId: "turn_123",
        serverName: "codex_apps",
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_name: "Slack",
          tool_title: "post_message",
          tool_params: {
            channel: "#launch",
          },
        },
        message: "Allow Slack to post a message?",
        requestedSchema: {
          type: "object",
          properties: {},
        },
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    });

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
          allowDestructiveActions: "on-request",
          appServer: { command: "codex", args: [] },
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

    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: "decline",
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "chatgpt_app_slack",
        arguments: {
          request: "Send a launch update to #launch",
        },
      });

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action: "decline",
              content: null,
              _meta: null,
            }),
          },
        ],
      });
    } finally {
      await Promise.all([client.close(), bridge.close()]);
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
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
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
