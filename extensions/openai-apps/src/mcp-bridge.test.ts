import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import type { ChatgptAppsConfig } from "./config.js";
import { ChatgptAppsMcpBridge } from "./mcp-bridge.js";
import type { RemoteCodexAppsClientFactory } from "./remote-codex-apps-client.js";
import type { PersistedConnectorSnapshot } from "./snapshot-cache.js";
import { resolveChatgptAppsStatePaths } from "./state-paths.js";

function createConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "openai-apps": {
          config: {
            enabled: true,
            appInvokePath: "remoteMCP",
            connectors: {
              slack: { enabled: true },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createWildcardConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "openai-apps": {
          config: {
            enabled: true,
            appInvokePath: "remoteMCP",
            connectors: {
              "*": { enabled: true },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createAppServerConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "openai-apps": {
          config: {
            enabled: true,
            appInvokePath: "appServer",
            connectors: {
              slack: { enabled: true },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createResolvedBundleConfig(params: {
  connectors: Record<string, { enabled: boolean }>;
  appInvokePath?: ChatgptAppsConfig["appInvokePath"];
}): ChatgptAppsConfig {
  return {
    enabled: true,
    appInvokePath: params.appInvokePath ?? "remoteMCP",
    appServer: { command: "codex", args: [] },
    linking: {
      enabled: false,
      waitTimeoutMs: 60_000,
      pollIntervalMs: 3_000,
    },
    connectors: params.connectors,
  };
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
  return await mkdtemp(path.join(os.tmpdir(), "openai-apps-bridge-"));
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

  it("does not publish internal collab tools from the persisted snapshot", async () => {
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
          _meta: {
            _codex_apps: {
              resource_uri: "connectors://collab/tools/collab_send_message",
            },
            connector_id: "collab",
          },
          inputSchema: {
            type: "object",
            properties: {
              message: {
                type: "string",
              },
            },
            required: ["message"],
          },
        },
      },
      resources: [],
      resourceTemplates: [],
      authStatus: "oAuth",
    });
    await writeSnapshot(stateDir, snapshot);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createWildcardConfig(),
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

    const tools = await bridge.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["chatgpt_app__slack__slack_send"]);
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

  it("routes tools/call through app-server when appInvokePath is appServer", async () => {
    const stateDir = await createStateDir();
    await writeSnapshot(stateDir);
    const appServerInvoker = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "app-server result" }],
    }));
    const remoteClientFactory = vi.fn(async () => {
      throw new Error("remote MCP should not be used for appServer invocation");
    });

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createAppServerConfig(),
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
      remoteClientFactory,
      appServerInvoker,
    });

    await bridge.listTools();
    const result = await bridge.callTool("chatgpt_app__slack__slack_send", {
      text: "hello",
    });

    expect(appServerInvoker).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({
          connectorId: "slack",
          publishedName: "chatgpt_app__slack__slack_send",
          remoteName: "slack_send",
          appId: "slack",
          appName: "Slack",
        }),
        args: {
          text: "hello",
        },
      }),
    );
    expect(remoteClientFactory).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: "text", text: "app-server result" }],
    });
  });

  it("drops remote output schemas so tool errors do not fail local validation", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.inventory[0] = {
      ...snapshot.inventory[0],
      id: "linear",
      name: "Linear",
      pluginDisplayNames: ["Linear"],
    };
    snapshot.statuses[0] = {
      ...snapshot.statuses[0],
      name: "linear",
      tools: {
        linear_get_profile: {
          name: "linear_get_profile",
          description: "Get Linear profile",
          _meta: {
            _codex_apps: {
              resource_uri: "connectors://linear/tools/linear_get_profile",
            },
            connector_id: "linear",
          },
          inputSchema: {
            type: "object",
            properties: {},
          },
          outputSchema: {
            type: "object",
            properties: {
              result: {
                type: "object",
              },
            },
            required: ["result"],
          },
        },
      },
    };
    await writeSnapshot(stateDir, snapshot);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () =>
        ({
          plugins: {
            entries: {
              "openai-apps": {
                config: {
                  enabled: true,
                  connectors: {
                    linear: { enabled: true },
                  },
                },
              },
            },
          },
        }) as OpenClawConfig,
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
          content: [{ type: "text", text: "remote error" }],
          structuredContent: {
            status: "error",
          },
        }),
        close: async () => {},
      }),
    });

    const tools = await bridge.listTools();
    expect(tools[0]?.outputSchema).toBeUndefined();
    await expect(bridge.callTool("chatgpt_app__linear__linear_get_profile", {})).resolves.toEqual({
      content: [{ type: "text", text: "remote error" }],
      structuredContent: {
        status: "error",
      },
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
        config: createResolvedBundleConfig({
          connectors: {
            slack: { enabled: true },
          },
        }),
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

  it("publishes all discoverable remote tools when wildcard enablement is active", async () => {
    const remoteTools: Tool[] = [
      {
        name: "gmail_search_emails",
        description: "Search Gmail",
        _meta: {
          connector_id: "gmail",
        },
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
      {
        name: "google_calendar_search_events",
        description: "Search Calendar",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
      {
        name: "google_calendar_read_event",
        description: "Read Calendar event",
        inputSchema: {
          type: "object",
          properties: {
            event_id: { type: "string" },
          },
        },
      },
      {
        name: "linear_search_issues",
        description: "Search Linear",
        _meta: {
          _codex_apps: {
            resource_uri: "connectors://linear/tools/linear_search_issues",
          },
        },
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
    ];
    const listTools = vi.fn(async () => ({
      tools: remoteTools,
    }));

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createWildcardConfig(),
      ensureFreshSnapshot: async () => ({
        status: "error",
        reason: "refresh",
        message: "Timed out refreshing ChatGPT apps snapshot",
        config: createResolvedBundleConfig({
          connectors: {
            "*": { enabled: true },
          },
        }),
        openclawConfig: createWildcardConfig(),
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
      remoteClientFactory: async () =>
        ({
          listTools,
          callTool: async () => ({
            content: [{ type: "text", text: "ok" }],
          }),
          close: async () => {},
        }) satisfies Awaited<ReturnType<RemoteCodexAppsClientFactory>>,
    });

    await expect(bridge.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "chatgpt_app__gmail__gmail_search_emails",
      }),
      expect.objectContaining({
        name: "chatgpt_app__google_calendar__google_calendar_search_events",
      }),
      expect.objectContaining({
        name: "chatgpt_app__google_calendar__google_calendar_read_event",
      }),
      expect.objectContaining({
        name: "chatgpt_app__linear__linear_search_issues",
      }),
    ]);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("waits for an initial snapshot refresh before publishing wildcard tools", async () => {
    const snapshot = createPersistedSnapshot();
    snapshot.inventory[0] = {
      ...snapshot.inventory[0],
      id: "gmail",
      name: "Gmail",
      pluginDisplayNames: ["Gmail"],
    };
    snapshot.statuses[0] = {
      ...snapshot.statuses[0],
      name: "gmail",
      tools: {
        gmail_search_emails: {
          name: "gmail_search_emails",
          description: "Search Gmail",
          _meta: {
            connector_id: "gmail",
          },
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
        },
      },
    } as PersistedConnectorSnapshot["statuses"][number];

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createWildcardConfig(),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "refresh",
        snapshot,
        config: createResolvedBundleConfig({
          connectors: {
            "*": { enabled: true },
          },
        }),
        openclawConfig: createWildcardConfig(),
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
      remoteClientFactory: async () =>
        ({
          listTools: async () => ({ tools: [] }),
          callTool: async () => ({
            content: [{ type: "text", text: "ok" }],
          }),
          close: async () => {},
        }) satisfies Awaited<ReturnType<RemoteCodexAppsClientFactory>>,
    });

    await expect(bridge.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "chatgpt_app__gmail__gmail_search_emails",
      }),
    ]);
  });

  it("uses an explicit hard refresh before serving a persisted snapshot", async () => {
    const stateDir = await createStateDir();
    await writeSnapshot(stateDir);

    const refreshedSnapshot = createPersistedSnapshot();
    refreshedSnapshot.inventory[0] = {
      ...refreshedSnapshot.inventory[0],
      id: "gmail",
      name: "Gmail",
      pluginDisplayNames: ["Gmail"],
    };
    refreshedSnapshot.statuses[0] = {
      ...refreshedSnapshot.statuses[0],
      name: "gmail",
      tools: {
        gmail_search_emails: {
          name: "gmail_search_emails",
          description: "Search Gmail",
          _meta: {
            connector_id: "gmail",
          },
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
        },
      },
    } as PersistedConnectorSnapshot["statuses"][number];

    const ensureFreshSnapshot = vi.fn(async () => ({
      status: "ok" as const,
      source: "refresh" as const,
      snapshot: refreshedSnapshot,
      config: createResolvedBundleConfig({
        connectors: {
          "*": { enabled: true },
        },
      }),
      openclawConfig: createWildcardConfig(),
      statePaths: resolveChatgptAppsStatePaths({
        OPENCLAW_STATE_DIR: stateDir,
        HOME: os.tmpdir(),
      }),
    }));

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createWildcardConfig(),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      hardRefresh: true,
      ensureFreshSnapshot,
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
        name: "chatgpt_app__gmail__gmail_search_emails",
      }),
    ]);
    expect(ensureFreshSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        hardRefresh: true,
      }),
    );
  });

  it("routes snapshot-published remote tools whose connector prefix contains spaces", async () => {
    const snapshot = createPersistedSnapshot();
    snapshot.inventory = [
      {
        id: "connector_947e0d954944416db111db556030eea6",
        name: "Google Calendar",
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
        pluginDisplayNames: [],
      },
    ];
    snapshot.statuses = [];

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createWildcardConfig(),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "refresh",
        snapshot,
        config: createResolvedBundleConfig({
          connectors: {
            "*": { enabled: true },
          },
        }),
        openclawConfig: createWildcardConfig(),
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
        listTools: async () => ({
          tools: [
            {
              name: "google calendar_search_events",
              description: "Search calendar events",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
              },
            },
          ] satisfies Tool[],
        }),
        callTool: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
        close: async () => {},
      }),
    });

    await expect(bridge.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "chatgpt_app__google_calendar__google_calendar_search_events",
      }),
    ]);
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
        config: createResolvedBundleConfig({
          connectors: {
            slack: { enabled: true },
          },
        }),
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

  it("drops non-schema entries from nested properties and $defs maps", async () => {
    const listTools = vi.fn(async () => ({
      tools: [
        {
          name: "gong_search",
          description: "Search Gong",
          _meta: {
            connector_id: "gong",
          },
          inputSchema: {
            type: "object",
            properties: {
              date_range: {
                $ref: "#/$defs/DateRange",
              },
            },
            $defs: {
              DateRange: {
                type: "object",
                properties: {
                  start_date: {
                    type: "string",
                  },
                  end_date: {
                    type: "string",
                  },
                  type: "object",
                  additionalProperties: true,
                },
              },
              type: "object",
              additionalProperties: true,
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
        config: createResolvedBundleConfig({
          connectors: {
            gong: { enabled: true },
          },
        }),
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
        date_range: {
          $ref: "#/$defs/DateRange",
        },
      },
      $defs: {
        DateRange: {
          type: "object",
          properties: {
            start_date: {
              type: "string",
            },
            end_date: {
              type: "string",
            },
          },
        },
      },
    });
  });

  it("adds empty properties to object schemas that only declare additionalProperties", async () => {
    const listTools = vi.fn(async () => ({
      tools: [
        {
          name: "google drive_batch_update_presentation",
          description: "Apply raw Google Slides batchUpdate requests",
          _meta: {
            connector_id: "google_drive_batch_update",
          },
          inputSchema: {
            type: "object",
            properties: {
              requests: {
                type: "array",
                items: {
                  $ref: "#/$defs/GoogleSlidesBatchUpdateRequestOperation",
                },
              },
            },
            required: ["requests"],
            $defs: {
              GoogleSlidesBatchUpdateRequestOperation: {
                type: "object",
                additionalProperties: true,
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
        config: createResolvedBundleConfig({
          connectors: {
            google_drive_batch_update: { enabled: true },
          },
        }),
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
        requests: {
          type: "array",
          items: {
            $ref: "#/$defs/GoogleSlidesBatchUpdateRequestOperation",
          },
        },
      },
      required: ["requests"],
      $defs: {
        GoogleSlidesBatchUpdateRequestOperation: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      },
    });
  });
});
