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
    listMcpServerStatus: async () =>
      ({
        data: [],
        nextCursor: null,
      }) as unknown as protocol.v2.ListMcpServerStatusResponse,
    writeConfigValue: async () => ({
      status: "ok",
      version: "1",
      filePath: "/tmp/openai-apps/config.toml",
      overriddenMetadata: null,
    }),
    startThread: async () => createThreadStartResponse(),
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
  // TODO: add back mentions
  it("creates a fresh thread and starts a turn without a per-call codex_apps warmup", async () => {
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
        appId: "asdk_app_gmail",
        publishedName: "chatgpt_app_gmail",
        appName: "Gmail",
        appInvocationToken: "gmail",
        availableToolNames: ["gmail_search_emails", "gmail_read_email"],
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
      cwd: process.cwd(),
      approvalPolicy: "never",
      developerInstructions: expect.stringContaining("Use the app mentioned in the user input"),
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thr_123",
        cwd: process.cwd(),
        approvalPolicy: "never",
        outputSchema: expect.objectContaining({
          type: "object",
          required: ["status", "result", "error"],
        }),
        input: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Summarize my recent emails"),
          }),
        ]),
      }),
      { timeoutMs: 180_000 },
    );
    expect(runTurn.mock.calls[0]?.[0].input[0]).toEqual(
      expect.objectContaining({
        text: "$gmail Summarize my recent emails",
      }),
    );
    expect(runTurn.mock.calls[0]?.[0].input[1]).toEqual({
      type: "mention",
      name: "Gmail",
      path: "app://asdk_app_gmail",
    });
    expect(registeredMethods).not.toContain("item/tool/call");
  });

  // TODO: doesn't work
  it.todo("answers app-server user-input prompts instead of failing immediately", async () => {
    let requestUserInputHandler: ((context: unknown) => Promise<unknown> | unknown) | undefined;
    const client = createMockClient({
      handleServerRequest: (method, handler) => {
        if (method === "item/tool/requestUserInput") {
          requestUserInputHandler = handler as (context: unknown) => Promise<unknown> | unknown;
        }
        return () => {};
      },
      runTurn: async () => {
        const response = await requestUserInputHandler?.({
          request: {
            params: {
              questions: [
                {
                  id: "question-1",
                  question: "Choose an inbox to search.",
                  options: [{ label: "Continue (Recommended)" }],
                },
              ],
            },
          },
        });
        expect(response).toEqual({
          answers: {
            "question-1": {
              answers: ["Continue"],
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
          appId: "asdk_app_gmail",
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
          availableToolNames: [],
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
    ).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("fails when the request payload is missing", async () => {
    const client = createMockClient();

    await expect(
      invokeViaAppServer({
        config,
        route: {
          connectorId: "gmail",
          appId: "asdk_app_gmail",
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
          availableToolNames: [],
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
          appId: "asdk_app_gmail",
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
          availableToolNames: [],
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

  it("fails clearly when the app-server reports an unsupported item/tool/call request", async () => {
    const client = createMockClient({
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
            status: "failed",
            error: {
              message: "Unhandled server request: item/tool/call",
              codexErrorInfo: null,
              additionalDetails: null,
            },
          },
        },
      }),
    });

    await expect(
      invokeViaAppServer({
        config,
        route: {
          connectorId: "gmail",
          appId: "asdk_app_gmail",
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
          availableToolNames: [],
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
    ).rejects.toThrow("App invocation requested unsupported server request: item/tool/call");
  });

  it("does not spend time listing mcp inventory during a normal tool invocation", async () => {
    const listMcpServerStatus = vi.fn<AppServerInvocationClient["listMcpServerStatus"]>(
      async () =>
        ({
          data: [],
          nextCursor: null,
        }) as unknown as protocol.v2.ListMcpServerStatusResponse,
    );
    const client = createMockClient({ listMcpServerStatus });

    await expect(
      invokeViaAppServer({
        config,
        route: {
          connectorId: "gmail",
          appId: "asdk_app_gmail",
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
          availableToolNames: ["gmail_search_emails", "gmail_read_email"],
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
    ).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(listMcpServerStatus).not.toHaveBeenCalled();
  });
});
