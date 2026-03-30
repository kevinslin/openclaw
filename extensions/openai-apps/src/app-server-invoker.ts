import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CodexAppServerClient,
  type ServerRequestContext,
  type protocol,
} from "codex-app-server-sdk";
import { resolveAppServerCommand } from "./app-server-command.js";
import type { ChatgptAppsResolvedAuth } from "./auth-projector.js";
import { buildDerivedAppsConfig, type ChatgptAppsConfig } from "./config.js";
import {
  createRemoteCodexAppsClient,
  type RemoteCodexAppsClient,
  type RemoteCodexAppsClientFactory,
} from "./remote-codex-apps-client.js";
import type { ChatgptAppsStatePaths } from "./state-paths.js";

type AppInfo = protocol.v2.AppInfo;
type AppsListResponse = protocol.v2.AppsListResponse;
type ConfigValueWriteParams = protocol.v2.ConfigValueWriteParams;
type ConfigWriteResponse = protocol.v2.ConfigWriteResponse;
type GetAuthStatusResponse = protocol.GetAuthStatusResponse;
type GetAccountResponse = protocol.v2.GetAccountResponse;
type LoginAccountParams = protocol.v2.LoginAccountParams;
type LoginAccountResponse = protocol.v2.LoginAccountResponse;
type ThreadReadResponse = protocol.v2.ThreadReadResponse;
type ThreadStartResponse = protocol.v2.ThreadStartResponse;
type TurnCompletedNotification = protocol.v2.TurnCompletedNotification;
type TurnStartResponse = protocol.v2.TurnStartResponse;
type UserInput = protocol.v2.UserInput;

const TURN_TIMEOUT_MS = 180_000;

function writeDebugLog(
  env: NodeJS.ProcessEnv | undefined,
  message: string,
  debugRootDir?: string,
): void {
  const line = `[openai-apps] ${new Date().toISOString()} ${message}\n`;
  if (env?.OPENCLAW_OPENAI_APPS_DEBUG === "1") {
    process.stderr.write(line);
  }
  if (!debugRootDir) {
    return;
  }
  try {
    appendFileSync(path.join(debugRootDir, "invocation-debug.log"), line);
  } catch {
    // Best effort only.
  }
}

export type AppServerInvocationRoute = {
  connectorId: string;
  remoteName: string;
  publishedName: string;
  appId: string;
  appName: string;
  appInvocationToken: string;
};

type ProjectedAuthResolver = () => Promise<ChatgptAppsResolvedAuth>;

type DynamicToolCallResponse = protocol.v2.DynamicToolCallResponse;

export type AppServerInvocationClient = {
  initializeSession(): Promise<unknown>;
  handleChatgptAuthTokensRefresh(
    handler: () =>
      | {
          accessToken: string;
          chatgptAccountId: string;
          chatgptPlanType?: string | null;
        }
      | Promise<{
          accessToken: string;
          chatgptAccountId: string;
          chatgptPlanType?: string | null;
        }>,
  ): () => void;
  loginAccount(params: LoginAccountParams): Promise<LoginAccountResponse>;
  readAccount(params: { refreshToken: boolean }): Promise<GetAccountResponse>;
  getAuthStatus(params: {
    includeToken: boolean | null;
    refreshToken: boolean | null;
  }): Promise<GetAuthStatusResponse>;
  writeConfigValue(params: ConfigValueWriteParams): Promise<ConfigWriteResponse>;
  startThread(params: {
    cwd?: string | null;
    ephemeral?: boolean | null;
    experimentalRawEvents: boolean;
    persistExtendedHistory: boolean;
  }): Promise<ThreadStartResponse>;
  listApps(params: {
    cursor?: string | null;
    threadId?: string | null;
    forceRefetch?: boolean;
  }): Promise<AppsListResponse>;
  runTurn(
    params: {
      threadId: string;
      input: UserInput[];
    },
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{
    start: TurnStartResponse;
    completed: TurnCompletedNotification;
  }>;
  readThread(params: { threadId: string; includeTurns: boolean }): Promise<ThreadReadResponse>;
  handleServerRequest<M extends protocol.ServerRequest["method"]>(
    method: M,
    handler: (context: ServerRequestContext<M>) => Promise<unknown> | unknown,
  ): () => void;
  onStderr?(listener: (chunk: string) => void): () => void;
  onClose?(
    listener: (event: {
      code: number | null;
      signal: NodeJS.Signals | null;
      hadError: boolean;
    }) => void,
  ): () => void;
  close(): Promise<void>;
};

export type AppServerToolInvoker = (params: {
  config: ChatgptAppsConfig;
  route: AppServerInvocationRoute;
  args: Record<string, unknown> | undefined;
  statePaths: ChatgptAppsStatePaths;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  resolveProjectedAuth: ProjectedAuthResolver;
  clientFactory?: (params: {
    command: string;
    args: string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<AppServerInvocationClient>;
  remoteClientFactory?: RemoteCodexAppsClientFactory;
}) => Promise<CallToolResult>;

function toLoginParams(
  auth: Extract<ChatgptAppsResolvedAuth, { status: "ok" }>,
): LoginAccountParams {
  return {
    type: "chatgptAuthTokens",
    accessToken: auth.accessToken,
    chatgptAccountId: auth.accountId,
    chatgptPlanType: auth.planType,
  };
}

function stringifyArgs(args: Record<string, unknown> | undefined): string {
  return JSON.stringify(args ?? {}, null, 2);
}

function buildInvocationInput(
  route: AppServerInvocationRoute,
  args: Record<string, unknown> | undefined,
) {
  const text =
    `$${route.appInvocationToken} Use the mentioned app to execute this request.\n\n` +
    `Published local tool: ${route.publishedName}\n` +
    `Requested connector: ${route.connectorId}\n` +
    `Requested app tool: ${route.remoteName}\n` +
    `Arguments JSON:\n${stringifyArgs(args)}\n\n` +
    "Return the result directly. If the app needs user input or approval, say exactly what is needed.";

  return [
    {
      type: "text",
      text,
      text_elements: [],
    },
    {
      type: "mention",
      name: route.appName,
      path: `app://${route.appId}`,
    },
  ] satisfies UserInput[];
}

function formatQuestionPrompts(
  questions: protocol.v2.ToolRequestUserInputParams["questions"],
): string {
  return questions
    .map((question) => question.question)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

async function listAppsForThread(
  client: AppServerInvocationClient,
  threadId: string,
): Promise<AppInfo[]> {
  const apps: AppInfo[] = [];
  let cursor: string | null = null;
  do {
    const response = await client.listApps({
      cursor,
      threadId,
      forceRefetch: false,
    });
    apps.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor);
  return apps;
}

function extractTurnText(response: ThreadReadResponse, turnId: string): string | null {
  const turn = response.thread.turns.find((entry) => entry.id === turnId);
  if (!turn) {
    return null;
  }

  const lastAgentMessage = [...turn.items]
    .reverse()
    .find((item) => item.type === "agentMessage" && item.text.trim().length > 0);
  if (lastAgentMessage?.type === "agentMessage") {
    return lastAgentMessage.text;
  }

  const lastToolResult = [...turn.items]
    .reverse()
    .find((item) => item.type === "mcpToolCall" && item.result !== null);
  if (lastToolResult?.type === "mcpToolCall") {
    const result = lastToolResult.result;
    if (!result) {
      return null;
    }
    if (result.structuredContent !== null) {
      return JSON.stringify(result.structuredContent, null, 2);
    }
    if (result.content.length > 0) {
      return JSON.stringify(result.content, null, 2);
    }
  }

  return null;
}

function buildApprovalError(prefix: string, detail?: string | null): Error {
  return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

function buildDynamicToolCallResponse(result: CallToolResult): DynamicToolCallResponse {
  const contentItems = result.content.flatMap((item) => {
    if (item.type === "text") {
      return [{ type: "inputText" as const, text: item.text }];
    }
    return [{ type: "inputText" as const, text: JSON.stringify(item, null, 2) }];
  });

  if (contentItems.length === 0 && result.structuredContent !== undefined) {
    contentItems.push({
      type: "inputText",
      text: JSON.stringify(result.structuredContent, null, 2),
    });
  }

  return {
    contentItems,
    success: result.isError !== true,
  };
}

export const invokeViaAppServer: AppServerToolInvoker = async (params) => {
  const env = params.env ?? process.env;
  writeDebugLog(
    env,
    `invoke start connector=${params.route.connectorId} remote=${params.route.remoteName} published=${params.route.publishedName}`,
    params.statePaths.rootDir,
  );
  const auth = await params.resolveProjectedAuth();
  if (auth.status !== "ok") {
    throw new Error(auth.message);
  }
  writeDebugLog(env, "app-server auth resolved", params.statePaths.rootDir);

  const resolvedCommand = await resolveAppServerCommand({
    command: params.config.appServer.command,
    env,
  });
  writeDebugLog(
    env,
    `app-server command resolved command=${resolvedCommand} args=${params.config.appServer.args.join(" ")}`,
    params.statePaths.rootDir,
  );
  await mkdir(params.statePaths.codexHomeDir, { recursive: true });
  writeDebugLog(env, "app-server codex home ensured", params.statePaths.rootDir);
  const clientFactory =
    params.clientFactory ??
    (async (factoryParams) => {
      const client = await CodexAppServerClient.spawn({
        bin: factoryParams.command,
        args: factoryParams.args,
        cwd: factoryParams.cwd,
        env: factoryParams.env,
        analyticsDefaultEnabled: true,
      });
      return {
        initializeSession: () => client.initializeSession(),
        handleChatgptAuthTokensRefresh: (handler) =>
          client.handleChatgptAuthTokensRefresh(async () => {
            const response = await handler();
            return {
              ...response,
              chatgptPlanType: response.chatgptPlanType ?? null,
            };
          }),
        loginAccount: (loginParams) => client.loginAccount(loginParams),
        readAccount: (readParams) => client.readAccount(readParams),
        getAuthStatus: (statusParams) => client.getAuthStatus(statusParams),
        writeConfigValue: (writeParams) => client.writeConfigValue(writeParams),
        startThread: (startParams) => client.startThread(startParams),
        listApps: (listParams) => client.listApps(listParams),
        runTurn: (turnParams, options) => client.runTurn(turnParams, options),
        readThread: (readParams) => client.readThread(readParams),
        handleServerRequest: (method, handlerFn) => client.handleServerRequest(method, handlerFn),
        onStderr: (listener) => client.onStderr(listener),
        onClose: (listener) => client.onClose(listener),
        close: async () => {
          await client.close();
        },
      } satisfies AppServerInvocationClient;
    });

  writeDebugLog(env, "app-server spawning client", params.statePaths.rootDir);
  const client = await clientFactory({
    command: resolvedCommand,
    args: params.config.appServer.args,
    cwd: params.workspaceDir,
    env: {
      ...env,
      CODEX_HOME: params.statePaths.codexHomeDir,
    },
  });
  writeDebugLog(env, "app-server client spawned", params.statePaths.rootDir);

  let unsubscribeRefresh: (() => void) | null = null;
  const unsubscribeHandlers: Array<() => void> = [];
  const unsubscribeDebugListeners: Array<() => void> = [];
  const remoteClientRef: { current: RemoteCodexAppsClient | null } = { current: null };
  try {
    if (client.onStderr) {
      unsubscribeDebugListeners.push(
        client.onStderr((chunk) => {
          writeDebugLog(env, `app-server stderr ${chunk.trimEnd()}`, params.statePaths.rootDir);
        }),
      );
    }
    if (client.onClose) {
      unsubscribeDebugListeners.push(
        client.onClose((event) => {
          writeDebugLog(
            env,
            `app-server close code=${String(event.code)} signal=${String(event.signal)} hadError=${String(event.hadError)}`,
            params.statePaths.rootDir,
          );
        }),
      );
    }
    await client.initializeSession();
    writeDebugLog(env, "app-server session initialized", params.statePaths.rootDir);
    unsubscribeRefresh = client.handleChatgptAuthTokensRefresh(async () => {
      writeDebugLog(env, "app-server requested auth refresh", params.statePaths.rootDir);
      const refreshed = await params.resolveProjectedAuth();
      if (refreshed.status !== "ok") {
        throw new Error(refreshed.message);
      }
      return {
        accessToken: refreshed.accessToken,
        chatgptAccountId: refreshed.accountId,
        chatgptPlanType: refreshed.planType,
      };
    });

    await client.loginAccount(toLoginParams(auth));
    writeDebugLog(env, "app-server login complete", params.statePaths.rootDir);
    await client.writeConfigValue({
      keyPath: "apps",
      value: buildDerivedAppsConfig(params.config) as protocol.v2.ConfigValueWriteParams["value"],
      mergeStrategy: "replace",
      expectedVersion: null,
    });
    writeDebugLog(env, "app-server config write complete", params.statePaths.rootDir);

    let serverRequestError: Error | null = null;
    const registerFailureHandler = <M extends protocol.ServerRequest["method"]>(
      method: M,
      buildError: (context: ServerRequestContext<M>) => Error,
    ) => {
      unsubscribeHandlers.push(
        client.handleServerRequest(method, async (context) => {
          writeDebugLog(env, `app-server request ${method}`, params.statePaths.rootDir);
          const error = buildError(context);
          serverRequestError ??= error;
          throw error;
        }),
      );
    };

    registerFailureHandler("item/tool/requestUserInput", (context) =>
      buildApprovalError(
        "App invocation requires additional user input",
        formatQuestionPrompts(context.request.params.questions),
      ),
    );
    registerFailureHandler("item/commandExecution/requestApproval", () =>
      buildApprovalError("App invocation requested command approval"),
    );
    registerFailureHandler("item/fileChange/requestApproval", () =>
      buildApprovalError("App invocation requested file change approval"),
    );
    registerFailureHandler("item/permissions/requestApproval", () =>
      buildApprovalError("App invocation requested permissions approval"),
    );
    registerFailureHandler("mcpServer/elicitation/request", () =>
      buildApprovalError("App invocation requested MCP elicitation"),
    );
    unsubscribeHandlers.push(
      client.handleServerRequest("item/tool/call", async (context) => {
        writeDebugLog(
          env,
          `app-server request item/tool/call tool=${context.request.params.tool}`,
          params.statePaths.rootDir,
        );
        remoteClientRef.current ??= await (
          params.remoteClientFactory ?? createRemoteCodexAppsClient
        )({
          auth: {
            accessToken: auth.accessToken,
            accountId: auth.accountId,
          },
        });
        try {
          const remoteArgs = context.request.params.arguments;
          const result = await remoteClientRef.current.callTool({
            name: context.request.params.tool,
            arguments:
              remoteArgs && typeof remoteArgs === "object" && !Array.isArray(remoteArgs)
                ? (remoteArgs as Record<string, unknown>)
                : undefined,
            _meta: undefined,
          });
          writeDebugLog(
            env,
            `app-server tool result tool=${context.request.params.tool} isError=${String(
              result.isError === true,
            )}`,
            params.statePaths.rootDir,
          );
          return buildDynamicToolCallResponse(result);
        } catch (error) {
          const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
          writeDebugLog(
            env,
            `app-server tool call failed tool=${context.request.params.tool} error=${message}`,
            params.statePaths.rootDir,
          );
          throw error;
        }
      }),
    );

    const threadStart = await client.startThread({
      cwd: params.workspaceDir ?? null,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    const threadId = threadStart.thread.id;
    writeDebugLog(env, `app-server thread started threadId=${threadId}`, params.statePaths.rootDir);
    let threadAppName = params.route.appName;
    try {
      const threadApps = await listAppsForThread(client, threadId);
      const threadApp = threadApps.find((app) => app.id === params.route.appId);
      if (!threadApp || !threadApp.isAccessible || !threadApp.isEnabled) {
        throw new Error(
          `App ${params.route.appId} is not accessible and enabled on the invocation thread`,
        );
      }
      threadAppName = threadApp.name || params.route.appName;
      writeDebugLog(
        env,
        `app-server thread app resolved appId=${threadApp.id} appName=${threadApp.name}`,
        params.statePaths.rootDir,
      );
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      writeDebugLog(
        env,
        `app-server thread app lookup skipped error=${message}`,
        params.statePaths.rootDir,
      );
    }

    const run = await client.runTurn(
      {
        threadId,
        input: buildInvocationInput(
          {
            ...params.route,
            appName: threadAppName,
          },
          params.args,
        ),
      },
      { timeoutMs: TURN_TIMEOUT_MS },
    );
    writeDebugLog(
      env,
      `app-server turn completed status=${run.completed.turn.status}`,
      params.statePaths.rootDir,
    );

    if (serverRequestError) {
      throw serverRequestError;
    }
    if (run.completed.turn.status !== "completed") {
      const message =
        run.completed.turn.error?.message ?? `Turn ended with status ${run.completed.turn.status}`;
      throw new Error(message);
    }

    const thread = await client.readThread({
      threadId,
      includeTurns: true,
    });
    const text = extractTurnText(thread, run.start.turn.id);
    if (!text) {
      throw new Error("App invocation completed without a usable final result");
    }
    writeDebugLog(env, "app-server invocation produced final text", params.statePaths.rootDir);

    return {
      content: [{ type: "text", text }],
    };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeDebugLog(env, `app-server invoke failed error=${message}`, params.statePaths.rootDir);
    throw error;
  } finally {
    for (const unsubscribe of unsubscribeDebugListeners) {
      unsubscribe();
    }
    for (const unsubscribe of unsubscribeHandlers) {
      unsubscribe();
    }
    unsubscribeRefresh?.();
    if (remoteClientRef.current) {
      await remoteClientRef.current.close();
    }
    await client.close();
  }
};
