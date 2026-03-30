import { mkdir } from "node:fs/promises";
import { CodexAppServerClient, type protocol } from "codex-app-server-sdk";
import {
  writeDerivedAppsConfig,
  type AppServerAppsConfigWriteGate,
} from "./app-server-apps-config.js";
import { resolveAppServerCommand } from "./app-server-command.js";
import type { ChatgptAppsResolvedAuth } from "./auth-projector.js";
import type { ChatgptAppsConfig } from "./config.js";
import type { ChatgptAppsStatePaths } from "./state-paths.js";

type GetAuthStatusResponse = protocol.GetAuthStatusResponse;
type AppInfo = protocol.v2.AppInfo;
type AppsListParams = protocol.v2.AppsListParams;
type AppsListResponse = protocol.v2.AppsListResponse;
type ConfigValueWriteParams = protocol.v2.ConfigValueWriteParams;
type ConfigWriteResponse = protocol.v2.ConfigWriteResponse;
type GetAccountParams = protocol.v2.GetAccountParams;
type GetAccountResponse = protocol.v2.GetAccountResponse;
type LoginAccountParams = protocol.v2.LoginAccountParams;
type LoginAccountResponse = protocol.v2.LoginAccountResponse;

export type AppServerRefreshCapture = {
  apps: AppInfo[];
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
  request(method: string, params?: unknown): Promise<unknown>;
  loginAccount(params: LoginAccountParams): Promise<LoginAccountResponse>;
  readAccount(params: GetAccountParams): Promise<GetAccountResponse>;
  getAuthStatus(params: {
    includeToken: boolean | null;
    refreshToken: boolean | null;
  }): Promise<GetAuthStatusResponse>;
  listApps(params: AppsListParams): Promise<AppsListResponse>;
  writeConfigValue(params: ConfigValueWriteParams): Promise<ConfigWriteResponse>;
  close(): Promise<void>;
};

type AppServerSessionParams = {
  config: ChatgptAppsConfig;
  statePaths: ChatgptAppsStatePaths;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  resolveProjectedAuth: ProjectedAuthResolver;
  appsConfigWriteGate?: AppServerAppsConfigWriteGate;
  clientFactory?: (params: {
    command: string;
    args: string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<ChatgptAppsRpcClient>;
};

type LoggedInAppServerAuth = Extract<ChatgptAppsResolvedAuth, { status: "ok" }>;

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

async function createAppServerRpcClient(factoryParams: {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}): Promise<ChatgptAppsRpcClient> {
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
    request: (method, requestParams) => client.request(method, requestParams),
    loginAccount: (loginParams) => client.loginAccount(loginParams),
    readAccount: (readParams) => client.readAccount(readParams),
    getAuthStatus: (statusParams) => client.getAuthStatus(statusParams),
    listApps: (listParams) => client.listApps(listParams),
    writeConfigValue: (writeParams) => client.writeConfigValue(writeParams),
    close: async () => {
      await client.close();
    },
  } satisfies ChatgptAppsRpcClient;
}

async function withLoggedInAppServerSession<TResult>(
  params: AppServerSessionParams,
  handler: (context: {
    auth: LoggedInAppServerAuth;
    client: ChatgptAppsRpcClient;
  }) => Promise<TResult>,
): Promise<TResult> {
  const env = params.env ?? process.env;
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
    (async (factoryParams) => await createAppServerRpcClient(factoryParams));
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
    await writeDerivedAppsConfig({
      config: params.config,
      writeConfigValue: (writeParams) => client.writeConfigValue(writeParams),
      appsConfigWriteGate: params.appsConfigWriteGate,
    });

    return await handler({ auth, client });
  } finally {
    unsubscribe?.();
    await client.close();
  }
}

export async function callAppServerMethod(
  params: AppServerSessionParams & {
    method: string;
    methodParams?: unknown;
  },
): Promise<unknown> {
  const method = params.method.trim();
  if (!method) {
    throw new Error("App server method name is required");
  }

  return await withLoggedInAppServerSession(params, async ({ client }) => {
    return await client.request(method, params.methodParams);
  });
}

export async function captureAppServerSnapshot(
  params: AppServerSessionParams & {
    now?: () => number;
  },
): Promise<AppServerRefreshCapture> {
  const now = params.now ?? Date.now;
  return await withLoggedInAppServerSession(params, async ({ client }) => {
    const apps: AppInfo[] = [];
    let appCursor: string | null = null;
    do {
      const response: AppsListResponse = await client.listApps({
        cursor: appCursor,
        forceRefetch: true,
      });
      apps.push(...response.data);
      appCursor = response.nextCursor;
    } while (appCursor);

    const [accountResponse, authStatus] = await Promise.all([
      client.readAccount({ refreshToken: false }),
      client.getAuthStatus({ includeToken: false, refreshToken: false }),
    ]);

    return {
      apps,
      projectedAt: new Date(now()).toISOString(),
      account: accountResponse.account,
      authStatus,
    };
  });
}
