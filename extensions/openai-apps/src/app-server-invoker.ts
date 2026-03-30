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
import type { ChatgptAppsStatePaths } from "./state-paths.js";

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

function resolveConversationSessionId(env: NodeJS.ProcessEnv | undefined): string | null {
  for (const candidate of [
    env?.OPENCLAW_SESSION_ID,
    env?.OPENCLAW_CONVERSATION_ID,
    env?.OPENCLAW_SESSION_KEY,
  ]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function serializeDebugValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function writeDebugLog(
  env: NodeJS.ProcessEnv | undefined,
  message: string,
  debugRootDir?: string,
): void {
  const conversationSessionId = resolveConversationSessionId(env);
  const context = conversationSessionId ? ` conversationSessionId=${conversationSessionId}` : "";
  const line = `[openai-apps] ${new Date().toISOString()}${context} ${message}\n`;
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
  appId: string;
  publishedName: string;
  appName: string;
  appInvocationToken: string;
  availableToolNames: string[];
};

type ProjectedAuthResolver = () => Promise<ChatgptAppsResolvedAuth>;

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

function readInvocationRequest(args: Record<string, unknown> | undefined): string {
  const request = typeof args?.request === "string" ? args.request.trim() : "";
  if (!request) {
    throw new Error('ChatGPT app tools require a non-empty "request" string');
  }
  return request;
}

function buildInvocationInput(
  route: AppServerInvocationRoute,
  args: Record<string, unknown> | undefined,
): UserInput[] {
  const request = readInvocationRequest(args);
  const capabilityGuidance =
    route.availableToolNames.length > 0
      ? `\n\nAvailable ${route.appName} connector tools in this session include: ${route.availableToolNames
          .slice(0, 12)
          .join(
            ", ",
          )}. Use the available tools when relevant, and only say a capability is unavailable if a tool call or permission check actually fails.`
      : "";
  return [
    {
      type: "text",
      text: `$${route.appInvocationToken} ${request}${capabilityGuidance}`,
      text_elements: [],
    },
    {
      type: "mention",
      name: route.appName,
      path: `app://${route.appId}`,
    },
  ];
}

function formatQuestionPrompts(
  questions: protocol.v2.ToolRequestUserInputParams["questions"],
): string {
  return questions
    .map((question) => question.question)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
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

function buildUnsupportedServerRequestError(message: string | null | undefined): Error | null {
  const trimmed = message?.trim();
  if (!trimmed) {
    return null;
  }

  const match =
    trimmed.match(/(?:unsupported|unhandled).*server request[:\s]+([a-z0-9_./-]+)/i) ??
    trimmed.match(/\b(item\/tool\/call)\b/i);
  const method = match?.[1]?.trim();
  if (!method) {
    return null;
  }

  return new Error(`App invocation requested unsupported server request: ${method}`);
}

export const invokeViaAppServer: AppServerToolInvoker = async (params) => {
  const env = params.env ?? process.env;
  writeDebugLog(
    env,
    `invoke start connector=${params.route.connectorId} published=${params.route.publishedName}`,
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
        runTurn: (turnParams, options) => client.runTurn(turnParams, options),
        readThread: (readParams) => client.readThread(readParams),
        handleServerRequest: (method, handler) => client.handleServerRequest(method, handler),
        onStderr: (listener) => client.onStderr(listener),
        onClose: (listener) => client.onClose(listener),
        close: async () => {
          await client.close();
        },
      } satisfies AppServerInvocationClient;
    });

  const client = await clientFactory({
    command: resolvedCommand,
    args: params.config.appServer.args,
    cwd: params.workspaceDir,
    env: {
      ...env,
      CODEX_HOME: params.statePaths.codexHomeDir,
    },
  });

  let unsubscribeRefresh: (() => void) | null = null;
  const unsubscribeHandlers: Array<() => void> = [];
  const unsubscribeDebugListeners: Array<() => void> = [];
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

    writeDebugLog(env, "app-server initialize start", params.statePaths.rootDir);
    await client.initializeSession();
    writeDebugLog(env, "app-server initialize done", params.statePaths.rootDir);
    unsubscribeRefresh = client.handleChatgptAuthTokensRefresh(async () => {
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

    writeDebugLog(env, "app-server login start", params.statePaths.rootDir);
    await client.loginAccount(toLoginParams(auth));
    writeDebugLog(env, "app-server login done", params.statePaths.rootDir);
    writeDebugLog(env, "app-server config write start", params.statePaths.rootDir);
    await client.writeConfigValue({
      keyPath: "apps",
      value: buildDerivedAppsConfig(params.config) as protocol.v2.ConfigValueWriteParams["value"],
      mergeStrategy: "replace",
      expectedVersion: null,
    });
    writeDebugLog(env, "app-server config write done", params.statePaths.rootDir);

    let serverRequestError: Error | null = null;
    const registerFailureHandler = <M extends protocol.ServerRequest["method"]>(
      method: M,
      buildError: (context: ServerRequestContext<M>) => Error,
    ) => {
      unsubscribeHandlers.push(
        client.handleServerRequest(method, async (context) => {
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

    let invocationInput: UserInput[];
    try {
      invocationInput = buildInvocationInput(params.route, params.args);
      writeDebugLog(
        env,
        `buildInvocationInput route=${serializeDebugValue(params.route)} args=${serializeDebugValue(params.args)} input=${serializeDebugValue(invocationInput)}`,
        params.statePaths.rootDir,
      );
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      writeDebugLog(
        env,
        `buildInvocationInput failed route=${serializeDebugValue(params.route)} args=${serializeDebugValue(params.args)} error=${serializeDebugValue(normalizedError.message)}`,
        params.statePaths.rootDir,
      );
      throw normalizedError;
    }

    writeDebugLog(env, "app-server thread start request", params.statePaths.rootDir);
    const threadStart = await client.startThread({
      cwd: params.workspaceDir ?? null,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    const threadId = threadStart.thread.id;
    writeDebugLog(env, `app-server thread started threadId=${threadId}`, params.statePaths.rootDir);

    writeDebugLog(env, "app-server turn start", params.statePaths.rootDir);
    const run = await client.runTurn(
      {
        threadId,
        input: invocationInput,
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
      const unsupportedServerRequestError = buildUnsupportedServerRequestError(
        run.completed.turn.error?.message ?? null,
      );
      if (unsupportedServerRequestError) {
        throw unsupportedServerRequestError;
      }
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
    const normalizedError =
      buildUnsupportedServerRequestError(error instanceof Error ? error.message : String(error)) ??
      (error instanceof Error ? error : new Error(String(error)));
    const message = normalizedError.stack ?? normalizedError.message;
    writeDebugLog(env, `app-server invoke failed error=${message}`, params.statePaths.rootDir);
    throw normalizedError;
  } finally {
    for (const unsubscribe of unsubscribeDebugListeners) {
      unsubscribe();
    }
    for (const unsubscribe of unsubscribeHandlers) {
      unsubscribe();
    }
    unsubscribeRefresh?.();
    await client.close();
  }
};
