import type { protocol } from "codex-app-server-sdk";
import { describe, expect, it } from "vitest";
import { createAppServerAppsConfigWriteGate } from "./app-server-apps-config.js";
import { callAppServerMethod, captureAppServerSnapshot } from "./app-server-session.js";
import type { ChatgptAppsConfig } from "./config.js";
import type { ChatgptAppsStatePaths } from "./state-paths.js";

type ConfigWriteResponse = protocol.v2.ConfigWriteResponse;
type GetAccountResponse = protocol.v2.GetAccountResponse;
type GetAuthStatusResponse = protocol.GetAuthStatusResponse;
type LoginAccountResponse = protocol.v2.LoginAccountResponse;

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
  rootDir: "/tmp/openclaw-chatgpt-apps",
  codexHomeDir: "/tmp/openclaw-chatgpt-apps/codex-home",
  snapshotPath: "/tmp/openclaw-chatgpt-apps/connectors.snapshot.json",
  derivedConfigPath: "/tmp/openclaw-chatgpt-apps/codex-apps.config.json",
  refreshDebugPath: "/tmp/openclaw-chatgpt-apps/refresh-debug.json",
};

describe("app-server session helpers", () => {
  it("logs in, writes config, and calls the requested app-server method", async () => {
    const events: string[] = [];

    const result = await callAppServerMethod({
      config,
      statePaths,
      method: "app/list",
      methodParams: { cursor: null, forceRefetch: true },
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      clientFactory: async () => ({
        initializeSession: async () => {
          events.push("initializeSession");
        },
        handleChatgptAuthTokensRefresh: () => () => {},
        request: async (method, params) => {
          events.push(`request:${method}:${JSON.stringify(params)}`);
          return { data: [{ name: "gmail" }], nextCursor: null };
        },
        loginAccount: async (): Promise<LoginAccountResponse> => {
          events.push("loginAccount");
          return { type: "chatgptAuthTokens" };
        },
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
          data: [],
          nextCursor: null,
        }),
        writeConfigValue: async (): Promise<ConfigWriteResponse> => {
          events.push("writeConfigValue");
          return {
            status: "ok",
            version: "1",
            filePath: "/tmp/openclaw-chatgpt-apps/config.toml",
            overriddenMetadata: null,
          };
        },
        close: async () => {
          events.push("close");
        },
      }),
    });

    expect(result).toEqual({
      data: [{ name: "gmail" }],
      nextCursor: null,
    });
    expect(events).toEqual([
      "initializeSession",
      "loginAccount",
      "writeConfigValue",
      'request:app/list:{"cursor":null,"forceRefetch":true}',
      "close",
    ]);
  });

  it("captures paginated app/list results without requiring status calls", async () => {
    const events: string[] = [];

    const result = await captureAppServerSnapshot({
      config,
      statePaths,
      now: () => new Date("2026-03-30T18:00:00.000Z").getTime(),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      clientFactory: async () => {
        let page = 0;
        return {
          initializeSession: async () => {},
          handleChatgptAuthTokensRefresh: () => () => {},
          request: async () => null,
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
          listApps: async () => {
            page += 1;
            events.push(`listApps:${page}`);
            if (page === 1) {
              return {
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
                nextCursor: "cursor-2",
              };
            }
            return {
              data: [
                {
                  id: "linear",
                  name: "Linear",
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
                  pluginDisplayNames: ["Linear"],
                },
              ],
              nextCursor: null,
            };
          },
          writeConfigValue: async (): Promise<ConfigWriteResponse> => ({
            status: "ok",
            version: "1",
            filePath: "/tmp/openclaw-chatgpt-apps/config.toml",
            overriddenMetadata: null,
          }),
          close: async () => {
            events.push("close");
          },
        };
      },
    });

    expect(result.apps.map((app) => app.id)).toEqual(["gmail", "linear"]);
    expect(result.projectedAt).toBe("2026-03-30T18:00:00.000Z");
    expect(events).toEqual(["listApps:1", "listApps:2", "close"]);
  });

  it("closes the client when app/list fails", async () => {
    const closeCalls: string[] = [];

    await expect(
      captureAppServerSnapshot({
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
          request: async () => null,
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
          listApps: async () => {
            throw new Error("app list unavailable");
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
      }),
    ).rejects.toThrow("app list unavailable");

    expect(closeCalls).toEqual(["closed"]);
  });

  it("reuses the shared apps config write across snapshot refresh and subsequent method calls", async () => {
    const appsConfigWriteGate = createAppServerAppsConfigWriteGate();
    const events: string[] = [];

    await captureAppServerSnapshot({
      config,
      statePaths,
      appsConfigWriteGate,
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      clientFactory: async () => ({
        initializeSession: async () => {
          events.push("snapshot:initializeSession");
        },
        handleChatgptAuthTokensRefresh: () => () => {},
        request: async () => null,
        loginAccount: async (): Promise<LoginAccountResponse> => {
          events.push("snapshot:loginAccount");
          return { type: "chatgptAuthTokens" };
        },
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
          data: [],
          nextCursor: null,
        }),
        writeConfigValue: async (): Promise<ConfigWriteResponse> => {
          events.push("snapshot:writeConfigValue");
          return {
            status: "ok",
            version: "1",
            filePath: "/tmp/openclaw-chatgpt-apps/config.toml",
            overriddenMetadata: null,
          };
        },
        close: async () => {
          events.push("snapshot:close");
        },
      }),
    });

    await callAppServerMethod({
      config,
      statePaths,
      method: "app/list",
      appsConfigWriteGate,
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      clientFactory: async () => ({
        initializeSession: async () => {
          events.push("method:initializeSession");
        },
        handleChatgptAuthTokensRefresh: () => () => {},
        request: async () => {
          events.push("method:request");
          return { data: [], nextCursor: null };
        },
        loginAccount: async (): Promise<LoginAccountResponse> => {
          events.push("method:loginAccount");
          return { type: "chatgptAuthTokens" };
        },
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
          data: [],
          nextCursor: null,
        }),
        writeConfigValue: async (): Promise<ConfigWriteResponse> => {
          events.push("method:writeConfigValue");
          return {
            status: "ok",
            version: "1",
            filePath: "/tmp/openclaw-chatgpt-apps/config.toml",
            overriddenMetadata: null,
          };
        },
        close: async () => {
          events.push("method:close");
        },
      }),
    });

    expect(events).toContain("snapshot:writeConfigValue");
    expect(events).not.toContain("method:writeConfigValue");
  });
});
