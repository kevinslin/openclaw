import os from "node:os";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import { ChatgptAppsMcpBridge } from "./mcp-bridge.js";
import type { EnsureFreshSnapshotResult } from "./refresh-snapshot.js";
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

function createSnapshotResult(): Extract<EnsureFreshSnapshotResult, { status: "ok" }> {
  const config = createConfig();
  return {
    status: "ok",
    source: "cache",
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
    openclawConfig: config,
    statePaths: resolveChatgptAppsStatePaths({
      OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "openclaw-chatgpt-apps-bridge"),
      HOME: os.tmpdir(),
    }),
    snapshot: {
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
    },
  };
}

describe("ChatgptAppsMcpBridge", () => {
  it("publishes rewritten tools from the persisted snapshot", async () => {
    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      ensureFreshSnapshot: async () => createSnapshotResult(),
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
      ensureFreshSnapshot: async () => createSnapshotResult(),
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
    const snapshotResult = createSnapshotResult();
    snapshotResult.snapshot.inventory[0] = {
      ...snapshotResult.snapshot.inventory[0],
      isEnabled: false,
    };
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
      ensureFreshSnapshot: async () => snapshotResult,
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
});
