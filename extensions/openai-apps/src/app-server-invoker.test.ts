import type { protocol } from "codex-app-server-sdk";
import { describe, expect, it, vi } from "vitest";
import { invokeViaAppServer, type AppServerInvocationClient } from "./app-server-invoker.js";
import type { ChatgptAppsConfig } from "./config.js";
import type { ChatgptAppsStatePaths } from "./state-paths.js";

const config: ChatgptAppsConfig = {
  enabled: true,
  appInvokePath: "appServer",
  appServer: {
    command: "codex",
    args: [],
  },
  linking: {
    enabled: false,
    waitTimeoutMs: 60_000,
    pollIntervalMs: 3_000,
  },
  connectors: {
    gmail: { enabled: true },
  },
};

const statePaths: ChatgptAppsStatePaths = {
  rootDir: "/tmp/openai-apps",
  codexHomeDir: "/tmp/openai-apps/codex-home",
  snapshotPath: "/tmp/openai-apps/connectors.snapshot.json",
  derivedConfigPath: "/tmp/openai-apps/codex-apps.config.json",
  refreshDebugPath: "/tmp/openai-apps/refresh-debug.json",
};

function createThreadStartResponse(): protocol.v2.ThreadStartResponse {
  return {
    thread: {
      id: "thr_123",
      preview: "",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: 0,
      updatedAt: 0,
      status: "idle",
      path: null,
      cwd: "/tmp",
      cliVersion: "0.0.0",
      source: "appServer",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp",
    approvalPolicy: {
      granular: {
        sandbox_approval: false,
        rules: false,
        skill_approval: false,
        request_permissions: false,
        mcp_elicitations: false,
      },
    },
    approvalsReviewer: null,
    sandbox: null,
    reasoningEffort: null,
  } as unknown as protocol.v2.ThreadStartResponse;
}

function createThreadReadResponse(items: protocol.v2.ThreadItem[]): protocol.v2.ThreadReadResponse {
  return {
    thread: {
      id: "thr_123",
      preview: "",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: 0,
      updatedAt: 0,
      status: "idle",
      path: null,
      cwd: "/tmp",
      cliVersion: "0.0.0",
      source: "appServer",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [
        {
          id: "turn_123",
          status: "completed",
          error: null,
          items,
        },
      ],
    },
  } as unknown as protocol.v2.ThreadReadResponse;
}

function createMockClient(
  overrides: Partial<AppServerInvocationClient> = {},
): AppServerInvocationClient {
  const serverRequestHandlers = new Map<string, (context: unknown) => Promise<unknown> | unknown>();
  return {
    initializeSession: async () => ({}),
    handleChatgptAuthTokensRefresh: () => () => {},
    loginAccount: async () => ({ type: "chatgptAuthTokens" }),
    readAccount: async () => ({ account: null, requiresOpenaiAuth: false }),
    getAuthStatus: async () => ({
      authMethod: "chatgpt",
      authToken: null,
      requiresOpenaiAuth: false,
    }),
    writeConfigValue: async () => ({
      status: "ok",
      version: "1",
      filePath: "/tmp/openai-apps/config.toml",
      overriddenMetadata: null,
    }),
    startThread: async () => createThreadStartResponse(),
    listApps: async () => ({
      data: [
        {
          id: "gmail",
          name: "Gmail",
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
          pluginDisplayNames: ["Gmail"],
        },
      ],
      nextCursor: null,
    }),
    runTurn: async () => ({
      start: {
        turn: {
          id: "turn_123",
          items: [],
          status: "inProgress",
          error: null,
        },
      },
      completed: {
        threadId: "thr_123",
        turn: {
          id: "turn_123",
          items: [],
          status: "completed",
          error: null,
        },
      },
    }),
    readThread: async () =>
      createThreadReadResponse([
        {
          type: "agentMessage",
          id: "msg_1",
          phase: "final_answer",
          text: "ok",
        },
      ]),
    handleServerRequest: (method, handler) => {
      serverRequestHandlers.set(
        method,
        handler as (context: unknown) => Promise<unknown> | unknown,
      );
      return () => {
        serverRequestHandlers.delete(method);
      };
    },
    close: async () => {},
    ...overrides,
  };
}

describe("invokeViaAppServer", () => {
  it("creates a fresh thread and starts a turn with an app mention", async () => {
    const startThread = vi.fn<AppServerInvocationClient["startThread"]>(async () =>
      createThreadStartResponse(),
    );
    const runTurn = vi.fn<AppServerInvocationClient["runTurn"]>(async () => ({
      start: {
        turn: {
          id: "turn_123",
          items: [],
          status: "inProgress",
          error: null,
        },
      },
      completed: {
        threadId: "thr_123",
        turn: {
          id: "turn_123",
          items: [],
          status: "completed",
          error: null,
        },
      },
    }));

    const client = createMockClient({
      startThread,
      runTurn,
    });

    const result = await invokeViaAppServer({
      config,
      route: {
        connectorId: "gmail",
        remoteName: "gmail_search_emails",
        publishedName: "chatgpt_app__gmail__gmail_search_emails",
        appId: "gmail",
        appName: "Gmail",
        appInvocationToken: "gmail",
      },
      args: { query: "in:inbox" },
      statePaths,
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      clientFactory: async () => client,
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(startThread).toHaveBeenCalledWith({
      cwd: null,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thr_123",
        input: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("$gmail"),
          }),
          {
            type: "mention",
            name: "Gmail",
            path: "app://gmail",
          },
        ],
      }),
      expect.any(Object),
    );
  });

  it("fails clearly when the app requests additional user input", async () => {
    let requestUserInputHandler: ((context: unknown) => Promise<unknown> | unknown) | undefined;
    const client = createMockClient({
      handleServerRequest: (method, handler) => {
        if (method === "item/tool/requestUserInput") {
          requestUserInputHandler = handler as (context: unknown) => Promise<unknown> | unknown;
        }
        return () => {};
      },
      runTurn: async () => {
        await requestUserInputHandler?.({
          request: {
            params: {
              questions: [{ question: "Choose an inbox to search." }],
            },
          },
        });
        return {
          start: {
            turn: {
              id: "turn_123",
              items: [],
              status: "inProgress",
              error: null,
            },
          },
          completed: {
            threadId: "thr_123",
            turn: {
              id: "turn_123",
              items: [],
              status: "failed",
              error: {
                message: "tool input required",
                codexErrorInfo: null,
                additionalDetails: null,
              },
            },
          },
        };
      },
    });

    await expect(
      invokeViaAppServer({
        config,
        route: {
          connectorId: "gmail",
          remoteName: "gmail_search_emails",
          publishedName: "chatgpt_app__gmail__gmail_search_emails",
          appId: "gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
        },
        args: { query: "in:inbox" },
        statePaths,
        resolveProjectedAuth: async () => ({
          status: "ok",
          accessToken: "access-token",
          accountId: "acct_123",
          planType: null,
          profileId: "openai-codex:default",
          identity: { email: "user@example.com", profileName: "user@example.com" },
        }),
        clientFactory: async () => client,
      }),
    ).rejects.toThrow("App invocation requires additional user input");
  });

  it("fails when the completed turn has no usable final result", async () => {
    const client = createMockClient({
      readThread: async () => createThreadReadResponse([]),
    });

    await expect(
      invokeViaAppServer({
        config,
        route: {
          connectorId: "gmail",
          remoteName: "gmail_search_emails",
          publishedName: "chatgpt_app__gmail__gmail_search_emails",
          appId: "gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
        },
        args: { query: "in:inbox" },
        statePaths,
        resolveProjectedAuth: async () => ({
          status: "ok",
          accessToken: "access-token",
          accountId: "acct_123",
          planType: null,
          profileId: "openai-codex:default",
          identity: { email: "user@example.com", profileName: "user@example.com" },
        }),
        clientFactory: async () => client,
      }),
    ).rejects.toThrow("App invocation completed without a usable final result");
  });

  it("fulfills item/tool/call requests through the remote apps client", async () => {
    let dynamicToolCallHandler: ((context: unknown) => Promise<unknown> | unknown) | undefined;
    const remoteCallTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "matched 5 emails" }],
    }));
    const client = createMockClient({
      handleServerRequest: (method, handler) => {
        if (method === "item/tool/call") {
          dynamicToolCallHandler = handler as (context: unknown) => Promise<unknown> | unknown;
        }
        return () => {};
      },
      runTurn: async () => {
        await dynamicToolCallHandler?.({
          request: {
            params: {
              threadId: "thr_123",
              turnId: "turn_123",
              callId: "call_123",
              tool: "gmail_search_emails",
              arguments: {
                query: "in:inbox",
              },
            },
          },
        });
        return {
          start: {
            turn: {
              id: "turn_123",
              items: [],
              status: "inProgress",
              error: null,
            },
          },
          completed: {
            threadId: "thr_123",
            turn: {
              id: "turn_123",
              items: [],
              status: "completed",
              error: null,
            },
          },
        };
      },
      readThread: async () =>
        createThreadReadResponse([
          {
            type: "agentMessage",
            id: "msg_1",
            phase: "final_answer",
            text: "Here are your 5 emails.",
          },
        ]),
    });

    const result = await invokeViaAppServer({
      config,
      route: {
        connectorId: "gmail",
        remoteName: "gmail_search_emails",
        publishedName: "chatgpt_app__gmail__gmail_search_emails",
        appId: "gmail",
        appName: "Gmail",
        appInvocationToken: "gmail",
      },
      args: { query: "in:inbox" },
      statePaths,
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      clientFactory: async () => client,
      remoteClientFactory: async () => ({
        listTools: async () => ({ tools: [] }),
        callTool: remoteCallTool,
        close: async () => {},
      }),
    });

    expect(remoteCallTool).toHaveBeenCalledWith({
      name: "gmail_search_emails",
      arguments: {
        query: "in:inbox",
      },
      _meta: undefined,
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "Here are your 5 emails." }],
    });
  });
});
