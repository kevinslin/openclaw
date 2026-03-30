import type { protocol } from "codex-app-server-sdk";
import { describe, expect, it, vi } from "vitest";
import { invokeViaAppServer, type AppServerInvocationClient } from "./app-server-invoker.js";
import type { ChatgptAppsConfig } from "./config.js";
import type { ChatgptAppsStatePaths } from "./state-paths.js";

const config: ChatgptAppsConfig = {
  enabled: true,
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
  registeredMethods: string[] = [],
): AppServerInvocationClient {
  const handlers = new Map<string, (context: unknown) => Promise<unknown> | unknown>();
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
      registeredMethods.push(method);
      handlers.set(method, handler as (context: unknown) => Promise<unknown> | unknown);
      return () => {
        handlers.delete(method);
      };
    },
    close: async () => {},
    ...overrides,
  };
}

describe("invokeViaAppServer", () => {
  it("creates a fresh thread and starts a turn with a connector mention", async () => {
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
    const registeredMethods: string[] = [];
    const client = createMockClient({ startThread, runTurn }, registeredMethods);

    const result = await invokeViaAppServer({
      config,
      route: {
        connectorId: "gmail",
        publishedName: "chatgpt_app_gmail",
        appName: "Gmail",
        appInvocationToken: "gmail",
      },
      args: { request: "Summarize my recent emails" },
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
            text: "$gmail Summarize my recent emails",
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
    expect(registeredMethods).not.toContain("item/tool/call");
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
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
        },
        args: { request: "Summarize my recent emails" },
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

  it("fails when the request payload is missing", async () => {
    const client = createMockClient();

    await expect(
      invokeViaAppServer({
        config,
        route: {
          connectorId: "gmail",
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
        },
        args: {},
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
    ).rejects.toThrow('ChatGPT app tools require a non-empty "request" string');
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
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
        },
        args: { request: "Summarize my recent emails" },
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
});
