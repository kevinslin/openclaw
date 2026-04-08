import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { protocol } from "codex-app-server-sdk";
import { describe, expect, it, vi } from "vitest";
import { createAppServerAppsConfigWriteGate } from "./app-server-apps-config.js";
import { invokeViaAppServer, type AppServerInvocationClient } from "./app-server-invoker.js";
import { buildDerivedAppsConfig, type ChatgptAppsConfig } from "./config.js";
import type { ChatgptAppsStatePaths } from "./state-paths.js";

const config: ChatgptAppsConfig = {
  enabled: true,
  allowDestructiveActions: "always",
  appServer: {
    command: "codex",
    args: [],
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

async function createTempStatePaths(): Promise<ChatgptAppsStatePaths> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openai-apps-invoker-"));
  return {
    rootDir,
    codexHomeDir: path.join(rootDir, "codex-home"),
    snapshotPath: path.join(rootDir, "connectors.snapshot.json"),
    derivedConfigPath: path.join(rootDir, "codex-apps.config.json"),
    refreshDebugPath: path.join(rootDir, "refresh-debug.json"),
  };
}

describe("invokeViaAppServer", () => {
  it("writes derived apps config into the shared codex home before the fresh invocation thread", async () => {
    const startThread = vi.fn<AppServerInvocationClient["startThread"]>(async () =>
      createThreadStartResponse(),
    );
    const writeConfigValue = vi.fn<AppServerInvocationClient["writeConfigValue"]>(async () => ({
      status: "ok",
      version: "1",
      filePath: "/tmp/openai-apps/config.toml",
      overriddenMetadata: null,
    }));
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
    let factoryEnv: NodeJS.ProcessEnv | undefined;
    const client = createMockClient({ startThread, runTurn, writeConfigValue }, registeredMethods);

    const result = await invokeViaAppServer({
      config,
      route: {
        connectorId: "gmail",
        appId: "asdk_app_gmail",
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
      clientFactory: async (factoryParams) => {
        factoryEnv = factoryParams.env;
        return client;
      },
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(factoryEnv?.CODEX_HOME).toBe(statePaths.codexHomeDir);
    expect(writeConfigValue).toHaveBeenCalledWith({
      keyPath: "apps",
      value: buildDerivedAppsConfig(config),
      mergeStrategy: "replace",
      expectedVersion: null,
    });
    expect(writeConfigValue.mock.invocationCallOrder[0]).toBeLessThan(
      startThread.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(startThread).toHaveBeenCalledWith({
      cwd: process.cwd(),
      approvalPolicy: {
        granular: {
          sandbox_approval: false,
          rules: false,
          skill_approval: false,
          request_permissions: true,
          mcp_elicitations: true,
        },
      },
      developerInstructions: expect.stringContaining("Use the app mentioned in the user input"),
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thr_123",
        cwd: process.cwd(),
        approvalPolicy: {
          granular: {
            sandbox_approval: false,
            rules: false,
            skill_approval: false,
            request_permissions: true,
            mcp_elicitations: true,
          },
        },
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

  it("creates and preserves the shared codex home directory across repeated invocations", async () => {
    const tempStatePaths = await createTempStatePaths();
    const observedHomeDirs: string[] = [];

    try {
      const runInvocation = async (request: string) =>
        await invokeViaAppServer({
          config,
          route: {
            connectorId: "gmail",
            appId: "asdk_app_gmail",
            publishedName: "chatgpt_app_gmail",
            appName: "Gmail",
            appInvocationToken: "gmail",
          },
          args: { request },
          statePaths: tempStatePaths,
          resolveProjectedAuth: async () => ({
            status: "ok",
            accessToken: "access-token",
            accountId: "acct_123",
            planType: null,
            profileId: "openai-codex:default",
            identity: { email: "user@example.com", profileName: "user@example.com" },
          }),
          clientFactory: async (factoryParams) => {
            const client = createMockClient();
            const info = await stat(tempStatePaths.codexHomeDir);
            if (info.isDirectory()) {
              observedHomeDirs.push(factoryParams.env.CODEX_HOME ?? "");
            }
            expect(factoryParams.env.CODEX_HOME).toBe(tempStatePaths.codexHomeDir);
            return client;
          },
        });

      await expect(runInvocation("Summarize my recent emails")).resolves.toEqual({
        content: [{ type: "text", text: "ok" }],
      });
      await expect(runInvocation("Summarize my second most recent email")).resolves.toEqual({
        content: [{ type: "text", text: "ok" }],
      });

      expect(observedHomeDirs).toEqual([tempStatePaths.codexHomeDir, tempStatePaths.codexHomeDir]);
      expect((await stat(tempStatePaths.codexHomeDir)).isDirectory()).toBe(true);
    } finally {
      await rm(tempStatePaths.rootDir, { recursive: true, force: true });
    }
  });

  it("uses OPENCLAW_OPENAI_APPS_TURN_TIMEOUT_MS when it is a positive integer", async () => {
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

    await expect(
      invokeViaAppServer({
        config,
        route: {
          connectorId: "gmail",
          appId: "asdk_app_gmail",
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
        },
        args: { request: "Summarize my recent emails" },
        statePaths,
        env: {
          ...process.env,
          OPENCLAW_OPENAI_APPS_TURN_TIMEOUT_MS: "600000",
        },
        resolveProjectedAuth: async () => ({
          status: "ok",
          accessToken: "access-token",
          accountId: "acct_123",
          planType: null,
          profileId: "openai-codex:default",
          identity: { email: "user@example.com", profileName: "user@example.com" },
        }),
        clientFactory: async () => createMockClient({ runTurn }),
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });

    expect(runTurn).toHaveBeenCalledWith(expect.anything(), { timeoutMs: 600_000 });
  });

  it("writes the derived apps config only once across repeated invocations in the same gateway session", async () => {
    const appsConfigWriteGate = createAppServerAppsConfigWriteGate();
    const writeConfigValue = vi.fn<AppServerInvocationClient["writeConfigValue"]>(async () => ({
      status: "ok",
      version: "1",
      filePath: "/tmp/openai-apps/config.toml",
      overriddenMetadata: null,
    }));

    const runInvocation = async (request: string) =>
      await invokeViaAppServer({
        config,
        route: {
          connectorId: "gmail",
          appId: "asdk_app_gmail",
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
        },
        args: { request },
        statePaths,
        resolveProjectedAuth: async () => ({
          status: "ok",
          accessToken: "access-token",
          accountId: "acct_123",
          planType: null,
          profileId: "openai-codex:default",
          identity: { email: "user@example.com", profileName: "user@example.com" },
        }),
        appsConfigWriteGate,
        clientFactory: async () => createMockClient({ writeConfigValue }),
      });

    await expect(runInvocation("Summarize my recent emails")).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    await expect(runInvocation("Summarize my starred emails")).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });

    expect(writeConfigValue).toHaveBeenCalledTimes(1);
    expect(writeConfigValue).toHaveBeenCalledWith({
      keyPath: "apps",
      value: buildDerivedAppsConfig(config),
      mergeStrategy: "replace",
      expectedVersion: null,
    });
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

  it("accepts destructive app elicitations when configured to always allow them", async () => {
    let elicitationHandler: ((context: unknown) => Promise<unknown> | unknown) | undefined;
    const client = createMockClient({
      handleServerRequest: (method, handler) => {
        if (method === "mcpServer/elicitation/request") {
          elicitationHandler = handler as (context: unknown) => Promise<unknown> | unknown;
        }
        return () => {};
      },
      runTurn: async () => {
        const response = await elicitationHandler?.({
          request: {
            params: {
              threadId: "thr_123",
              turnId: "turn_123",
              serverName: "gmail",
              mode: "form",
              message: "Confirm destructive action.",
              requestedSchema: {
                type: "object",
                properties: {},
              },
              _meta: {
                codex_approval_kind: "mcp_tool_call",
                connector_name: "Gmail",
                tool_title: "send_email",
                tool_params: {
                  to: "user@example.com",
                },
              },
            },
          },
        });
        expect(response).toEqual({
          action: "accept",
          content: {},
          _meta: null,
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
    });

    await expect(
      invokeViaAppServer({
        config: {
          ...config,
          allowDestructiveActions: "always",
        },
        route: {
          connectorId: "gmail",
          appId: "asdk_app_gmail",
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
        },
        args: { request: "Send the email" },
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

  it("declines destructive app elicitations when configured to never allow them", async () => {
    let elicitationHandler: ((context: unknown) => Promise<unknown> | unknown) | undefined;
    const readThread = vi.fn<AppServerInvocationClient["readThread"]>(async () =>
      createThreadReadResponse([
        {
          type: "agentMessage",
          id: "msg_1",
          phase: "final_answer",
          text: "Google Calendar does not support write actions.",
        },
      ]),
    );
    const client = createMockClient({
      readThread,
      handleServerRequest: (method, handler) => {
        if (method === "mcpServer/elicitation/request") {
          elicitationHandler = handler as (context: unknown) => Promise<unknown> | unknown;
        }
        return () => {};
      },
      runTurn: async () => {
        const response = await elicitationHandler?.({
          request: {
            params: {
              threadId: "thr_123",
              turnId: "turn_123",
              serverName: "google_calendar",
              mode: "form",
              message: "Confirm event creation.",
              requestedSchema: {
                type: "object",
                properties: {},
              },
              _meta: {
                codex_approval_kind: "mcp_tool_call",
                connector_name: "Google Calendar",
                tool_title: "create_event",
              },
            },
          },
        });
        expect(response).toEqual({
          action: "decline",
          content: null,
          _meta: null,
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
    });

    await expect(
      invokeViaAppServer({
        config: {
          ...config,
          allowDestructiveActions: "never",
        },
        route: {
          connectorId: "google_calendar",
          appId: "asdk_app_google_calendar",
          publishedName: "chatgpt_app_google_calendar",
          appName: "Google Calendar",
          appInvocationToken: "google_calendar",
        },
        args: { request: "Create the event" },
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
      content: [
        {
          type: "text",
          text: "OpenClaw is configured with allowDestructiveActions=never, so I can't perform write actions for Google Calendar.",
        },
      ],
    });
    expect(readThread).not.toHaveBeenCalled();
  });

  it("delegates destructive app elicitations to the provided handler when configured for on-request", async () => {
    let elicitationHandler: ((context: unknown) => Promise<unknown> | unknown) | undefined;
    const outerElicitationHandler = vi.fn(async () => ({
      action: "accept" as const,
      content: {},
      _meta: null,
    }));
    const client = createMockClient({
      handleServerRequest: (method, handler) => {
        if (method === "mcpServer/elicitation/request") {
          elicitationHandler = handler as (context: unknown) => Promise<unknown> | unknown;
        }
        return () => {};
      },
      runTurn: async () => {
        const requestParams = {
          threadId: "thr_123",
          turnId: "turn_123",
          serverName: "google_calendar",
          mode: "form" as const,
          message: "Confirm event creation.",
          requestedSchema: {
            type: "object" as const,
            properties: {},
          },
          _meta: {
            codex_approval_kind: "mcp_tool_call",
            connector_name: "Google Calendar",
            tool_title: "create_event",
            tool_params: {
              title: "test-123",
            },
          },
        };
        const response = await elicitationHandler?.({
          request: {
            params: requestParams,
          },
        });
        expect(response).toEqual({
          action: "accept",
          content: {},
          _meta: null,
        });
        expect(outerElicitationHandler).toHaveBeenCalledWith(requestParams);
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
    });

    await expect(
      invokeViaAppServer({
        config: {
          ...config,
          allowDestructiveActions: "on-request",
        },
        route: {
          connectorId: "google_calendar",
          appId: "asdk_app_google_calendar",
          publishedName: "chatgpt_app_google_calendar",
          appName: "Google Calendar",
          appInvocationToken: "google_calendar",
        },
        args: { request: "Create the event" },
        statePaths,
        resolveProjectedAuth: async () => ({
          status: "ok",
          accessToken: "access-token",
          accountId: "acct_123",
          planType: null,
          profileId: "openai-codex:default",
          identity: { email: "user@example.com", profileName: "user@example.com" },
        }),
        handleMcpServerElicitation: outerElicitationHandler,
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

  it("keeps invocation routing independent from refresh-only inventory metadata", async () => {
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
});
