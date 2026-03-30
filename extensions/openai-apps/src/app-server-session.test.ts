import type { protocol } from "codex-app-server-sdk";
import { describe, expect, it } from "vitest";
import { captureAppServerSnapshot } from "./app-server-session.js";
import type { ChatgptAppsConfig } from "./config.js";
import type { ChatgptAppsStatePaths } from "./state-paths.js";

type ConfigWriteResponse = protocol.v2.ConfigWriteResponse;
type GetAccountResponse = protocol.v2.GetAccountResponse;
type GetAuthStatusResponse = protocol.GetAuthStatusResponse;
type LoginAccountResponse = protocol.v2.LoginAccountResponse;

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
  rootDir: "/tmp/openclaw-chatgpt-apps",
  codexHomeDir: "/tmp/openclaw-chatgpt-apps/codex-home",
  snapshotPath: "/tmp/openclaw-chatgpt-apps/connectors.snapshot.json",
  derivedConfigPath: "/tmp/openclaw-chatgpt-apps/codex-apps.config.json",
  refreshDebugPath: "/tmp/openclaw-chatgpt-apps/refresh-debug.json",
};

describe("captureAppServerSnapshot", () => {
  it("keeps inventory refresh successful when mcpServerStatus/list fails", async () => {
    const closeCalls: string[] = [];

    const result = await captureAppServerSnapshot({
      config,
      statePaths,
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      clientFactory: async () => ({
        initializeSession: async () => {},
        handleChatgptAuthTokensRefresh: () => () => {},
        loginAccount: async (): Promise<LoginAccountResponse> => ({
          type: "chatgptAuthTokens",
        }),
        readAccount: async (): Promise<GetAccountResponse> => ({
          account: null,
          requiresOpenaiAuth: false,
        }),
        getAuthStatus: async (): Promise<GetAuthStatusResponse> => ({
          authMethod: "chatgpt",
          authToken: null,
          requiresOpenaiAuth: false,
        }),
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
        listMcpServerStatus: async () => {
          throw new Error("status unavailable");
        },
        writeConfigValue: async (): Promise<ConfigWriteResponse> => ({
          status: "ok",
          version: "1",
          filePath: "/tmp/openclaw-chatgpt-apps/config.toml",
          overriddenMetadata: null,
        }),
        close: async () => {
          closeCalls.push("closed");
        },
      }),
    });

    expect(result.inventory).toHaveLength(1);
    expect(result.statuses).toEqual([]);
    expect(closeCalls).toEqual(["closed"]);
  });
});
