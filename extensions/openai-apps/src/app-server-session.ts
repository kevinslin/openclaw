import { mkdir } from "node:fs/promises";
import { CodexAppServerClient, type protocol } from "codex-app-server-sdk";
import { resolveAppServerCommand } from "./app-server-command.js";
import type { ChatgptAppsResolvedAuth } from "./auth-projector.js";
import type { ChatgptAppsConfig } from "./config.js";
import { buildDerivedAppsConfig } from "./config.js";
import type { ChatgptAppsStatePaths } from "./state-paths.js";

type GetAuthStatusResponse = protocol.GetAuthStatusResponse;
type AppInfo = protocol.v2.AppInfo;
type AppsListParams = protocol.v2.AppsListParams;
type AppsListResponse = protocol.v2.AppsListResponse;
type ConfigValueWriteParams = protocol.v2.ConfigValueWriteParams;
type ConfigWriteResponse = protocol.v2.ConfigWriteResponse;
type GetAccountParams = protocol.v2.GetAccountParams;
type GetAccountResponse = protocol.v2.GetAccountResponse;
type ListMcpServerStatusParams = protocol.v2.ListMcpServerStatusParams;
type ListMcpServerStatusResponse = protocol.v2.ListMcpServerStatusResponse;
type LoginAccountParams = protocol.v2.LoginAccountParams;
type LoginAccountResponse = protocol.v2.LoginAccountResponse;
type McpServerStatus = protocol.v2.McpServerStatus;

const MCP_SERVER_STATUS_TIMEOUT_MS = 5_000;

export type AppServerRefreshCapture = {
  inventory: AppInfo[];
  statuses: McpServerStatus[];
  projectedAt: string;
  account: GetAccountResponse["account"];
  authStatus: GetAuthStatusResponse;
};

type ProjectedAuthResolver = () => Promise<ChatgptAppsResolvedAuth>;

type ChatgptAppsRpcClient = {
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
  readAccount(params: GetAccountParams): Promise<GetAccountResponse>;
  getAuthStatus(params: {
    includeToken: boolean | null;
    refreshToken: boolean | null;
  }): Promise<GetAuthStatusResponse>;
  listApps(params: AppsListParams): Promise<AppsListResponse>;
  listMcpServerStatus(params: ListMcpServerStatusParams): Promise<ListMcpServerStatusResponse>;
  writeConfigValue(params: ConfigValueWriteParams): Promise<ConfigWriteResponse>;
  close(): Promise<void>;
};

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

export async function captureAppServerSnapshot(params: {
  config: ChatgptAppsConfig;
  statePaths: ChatgptAppsStatePaths;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  resolveProjectedAuth: ProjectedAuthResolver;
  now?: () => number;
  clientFactory?: (params: {
    command: string;
    args: string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<ChatgptAppsRpcClient>;
}): Promise<AppServerRefreshCapture> {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now;
  const auth = await params.resolveProjectedAuth();
  if (auth.status !== "ok") {
    throw new Error(auth.message);
  }

  await mkdir(params.statePaths.codexHomeDir, { recursive: true });
  const resolvedCommand = await resolveAppServerCommand({
    command: params.config.appServer.command,
    env,
  });
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
        listApps: (listParams) => client.listApps(listParams),
        listMcpServerStatus: (listParams) => client.listMcpServerStatus(listParams),
        writeConfigValue: (writeParams) => client.writeConfigValue(writeParams),
        close: async () => {
          await client.close();
        },
      } satisfies ChatgptAppsRpcClient;
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

  let unsubscribe: (() => void) | null = null;
  try {
    await client.initializeSession();
    unsubscribe = client.handleChatgptAuthTokensRefresh(async () => {
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
    await client.writeConfigValue({
      keyPath: "apps",
      value: buildDerivedAppsConfig(params.config),
      mergeStrategy: "replace",
      expectedVersion: null,
    });

    const inventory: AppInfo[] = [];
    let appCursor: string | null = null;
    do {
      const response: AppsListResponse = await client.listApps({
        cursor: appCursor,
        forceRefetch: true,
      });
      inventory.push(...response.data);
      appCursor = response.nextCursor;
    } while (appCursor);

    const statuses = await listMcpServerStatuses(client);

    const [accountResponse, authStatus] = await Promise.all([
      client.readAccount({ refreshToken: false }),
      client.getAuthStatus({ includeToken: false, refreshToken: false }),
    ]);

    return {
      inventory,
      statuses,
      projectedAt: new Date(now()).toISOString(),
      account: accountResponse.account,
      authStatus,
    };
  } finally {
    unsubscribe?.();
    await client.close();
  }
}

async function listMcpServerStatuses(client: ChatgptAppsRpcClient): Promise<McpServerStatus[]> {
  const listStatuses = async (): Promise<McpServerStatus[]> => {
    const statuses: McpServerStatus[] = [];
    let statusCursor: string | null = null;
    do {
      const response: ListMcpServerStatusResponse = await client.listMcpServerStatus({
        cursor: statusCursor,
      });
      statuses.push(...response.data);
      statusCursor = response.nextCursor;
    } while (statusCursor);
    return statuses;
  };

  return await Promise.race([
    listStatuses(),
    new Promise<McpServerStatus[]>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Timed out reading mcpServerStatus/list"));
      }, MCP_SERVER_STATUS_TIMEOUT_MS);
    }),
  ]);
}
