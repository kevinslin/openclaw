import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import { ChatgptAppsMcpBridge } from "./mcp-bridge.js";
import type { RemoteCodexAppsClientFactory } from "./remote-codex-apps-client.js";
import { resolveChatgptAppsStatePaths } from "./state-paths.js";

function createConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {
        openai: {
          config: {
            chatgptApps: {
              enabled: true,
              chatgptBaseUrl: "https://chatgpt.com",
              connectors: {
                slack: { enabled: true },
              },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createPersistedSnapshot() {
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
            _meta: {
              _codex_apps: {
                resource_uri: "connectors://slack/tools/slack_send",
              },
              connector_id: "slack",
            },
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
  return await mkdtemp(path.join(os.tmpdir(), "openclaw-chatgpt-apps-bridge-"));
}

describe("ChatgptAppsMcpBridge", () => {
  it("publishes rewritten tools from the persisted snapshot", async () => {
    const stateDir = await createStateDir();
    await writeSnapshot(stateDir);
    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      ensureFreshSnapshot: async () => {
        await new Promise(() => {});
        throw new Error("unreachable");
      },
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      remoteClientFactory: async () => ({
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
        close: async () => {},
      }),
    });

    await expect(bridge.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "chatgpt_app__slack__slack_send",
        description: "Send to Slack",
      }),
    ]);
  });

  it("forwards tools/call to the remote ChatGPT apps endpoint", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "sent" }],
    }));
    const listTools = vi.fn(async () => ({
      tools: [],
    }));
    const remoteClientFactory = vi.fn(
      async () =>
        ({
          listTools,
          callTool,
          close: async () => {},
        }) satisfies Awaited<ReturnType<RemoteCodexAppsClientFactory>>,
    ) as RemoteCodexAppsClientFactory & ReturnType<typeof vi.fn>;
    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      ensureFreshSnapshot: async () => {
        throw new Error("refresh should not be required for tools/call");
      },
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      remoteClientFactory,
    });

    await bridge.listTools();
    const result = await bridge.callTool("chatgpt_app__slack__slack_send", {
      text: "hello",
    });

    expect(remoteClientFactory).toHaveBeenCalledWith({
      chatgptBaseUrl: "https://chatgpt.com",
      auth: {
        accessToken: "access-token",
        accountId: "acct_123",
      },
    });
    expect(callTool).toHaveBeenCalledWith({
      name: "slack_send",
      arguments: {
        text: "hello",
      },
      _meta: {
        _codex_apps: {
          resource_uri: "connectors://slack/tools/slack_send",
        },
        connector_id: "slack",
      },
    });
    expect(listTools).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: "text", text: "sent" }],
    });
  });

  it("publishes explicitly configured accessible connectors even when app/list reports them disabled", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.inventory[0] = {
      ...snapshot.inventory[0],
      isEnabled: false,
    };
    snapshot.statuses = [];
    await writeSnapshot(stateDir, snapshot);
    const listTools = vi.fn(
      async (): Promise<{ tools: Tool[] }> => ({
        tools: [
          {
            name: "slack_send",
            title: "Send",
            description: "Send a message",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string" },
              },
            },
          },
        ],
      }),
    );

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      ensureFreshSnapshot: async () => {
        throw new Error("refresh should not block listTools");
      },
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      remoteClientFactory: async () => ({
        listTools,
        callTool: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
        close: async () => {},
      }),
    });

    await expect(bridge.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "chatgpt_app__slack__slack_send",
      }),
    ]);
  });

  it("falls back to remote listTools when status snapshots are unavailable", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.statuses = [];
    await writeSnapshot(stateDir, snapshot);
    const listTools = vi.fn(async () => ({
      tools: [
        {
          name: "slack_send",
          description: "Send to Slack",
          _meta: {
            connector_id: "slack",
          },
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
        },
      ] satisfies Tool[],
    }));

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      ensureFreshSnapshot: async () => {
        throw new Error("refresh should not block listTools");
      },
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      remoteClientFactory: async () => ({
        listTools,
        callTool: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
        close: async () => {},
      }),
    });

    await expect(bridge.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "chatgpt_app__slack__slack_send",
        description: "Send to Slack",
      }),
    ]);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("falls back to remote listTools when snapshot refresh fails", async () => {
    const listTools = vi.fn(async () => ({
      tools: [
        {
          name: "slack_send",
          description: "Send to Slack",
          _meta: {
            connector_id: "slack",
          },
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
        },
      ] satisfies Tool[],
    }));

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      ensureFreshSnapshot: async () => ({
        status: "error",
        reason: "refresh",
        message: "Timed out refreshing ChatGPT apps snapshot",
        config: {
          enabled: true,
          chatgptBaseUrl: "https://chatgpt.com",
          appServer: { command: "codex", args: [] },
          linking: {
            enabled: false,
            waitTimeoutMs: 60_000,
            pollIntervalMs: 3_000,
          },
          connectors: {
            slack: { enabled: true },
          },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "openclaw-chatgpt-apps-bridge"),
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
      remoteClientFactory: async () => ({
        listTools,
        callTool: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
        close: async () => {},
      }),
    });

    await expect(bridge.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "chatgpt_app__slack__slack_send",
      }),
    ]);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("does not block tools/list on background snapshot refresh", async () => {
    const listTools = vi.fn(async () => ({
      tools: [
        {
          name: "slack_send",
          description: "Send to Slack",
          _meta: {
            connector_id: "slack",
          },
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
        },
      ] satisfies Tool[],
    }));

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      ensureFreshSnapshot: async () => {
        await new Promise(() => {});
        throw new Error("unreachable");
      },
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      remoteClientFactory: async () => ({
        listTools,
        callTool: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
        close: async () => {},
      }),
    });

    await expect(bridge.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "chatgpt_app__slack__slack_send",
      }),
    ]);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("sanitizes nested anyOf branches inside remote tool schemas", async () => {
    const listTools = vi.fn(async () => ({
      tools: [
        {
          name: "slack_send",
          description: "Send to Slack",
          _meta: {
            connector_id: "slack",
          },
          inputSchema: {
            type: "object",
            properties: {
              filters: {
                $defs: {
                  filterValue: {
                    anyOf: [
                      {
                        type: "string",
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                },
                type: "object",
                properties: {
                  query: {
                    $ref: "#/$defs/filterValue",
                  },
                },
              },
            },
          },
        },
      ] satisfies Tool[],
    }));

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      ensureFreshSnapshot: async () => ({
        status: "error",
        reason: "refresh",
        message: "Timed out refreshing ChatGPT apps snapshot",
        config: {
          enabled: true,
          chatgptBaseUrl: "https://chatgpt.com",
          appServer: { command: "codex", args: [] },
          linking: {
            enabled: false,
            waitTimeoutMs: 60_000,
            pollIntervalMs: 3_000,
          },
          connectors: {
            slack: { enabled: true },
          },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "openclaw-chatgpt-apps-bridge"),
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
      remoteClientFactory: async () => ({
        listTools,
        callTool: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
        close: async () => {},
      }),
    });

    const tools = await bridge.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        filters: {
          $defs: {
            filterValue: {
              type: "string",
            },
          },
          type: "object",
          properties: {
            query: {
              $ref: "#/$defs/filterValue",
            },
          },
        },
      },
    });
  });
});
