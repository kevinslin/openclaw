import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerRefreshCapture } from "./app-server-session.js";
import { ensureFreshSnapshot } from "./refresh-snapshot.js";
import { readPersistedSnapshot } from "./snapshot-cache.js";
import { resolveChatgptAppsStatePaths } from "./state-paths.js";

function createConfig(connectors?: Record<string, { enabled: boolean }>): OpenClawConfig {
  return {
    plugins: {
      entries: {
        openai: {
          config: {
            chatgptApps: {
              enabled: true,
              chatgptBaseUrl: "https://chatgpt.com",
              connectors: connectors ?? {},
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createCapture(): AppServerRefreshCapture {
  return {
    inventory: [
      {
        id: "slack",
        name: "Slack",
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
        pluginDisplayNames: ["Slack"],
      },
    ],
    statuses: [
      {
        name: "slack",
        tools: {
          slack_send: {
            name: "slack_send",
            description: "Send to Slack",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string" },
              },
              required: ["text"],
            },
          },
        },
        resources: [],
        resourceTemplates: [],
        authStatus: "oAuth",
      },
    ],
    projectedAt: "2026-03-29T18:00:00.000Z",
    account: null,
    authStatus: {
      authMethod: "chatgpt",
      authToken: null,
      requiresOpenaiAuth: false,
    },
  };
}

let tempRoot = "";

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
  tempRoot = "";
});

describe("ensureFreshSnapshot", () => {
  it("refreshes once and reuses the cached snapshot while it is fresh", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chatgpt-apps-"));
    const env = {
      OPENCLAW_STATE_DIR: tempRoot,
      HOME: tempRoot,
    };
    const captureSnapshot = vi.fn(async () => createCapture());

    const first = await ensureFreshSnapshot({
      loadOpenClawConfig: () => createConfig(),
      env,
      now: () => new Date("2026-03-29T18:01:00.000Z").getTime(),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      captureSnapshot,
    });

    expect(first.status).toBe("ok");
    expect(first.status === "ok" ? first.source : "unexpected").toBe("refresh");
    expect(captureSnapshot).toHaveBeenCalledTimes(1);

    const second = await ensureFreshSnapshot({
      loadOpenClawConfig: () => createConfig(),
      env,
      now: () => new Date("2026-03-29T19:00:00.000Z").getTime(),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      captureSnapshot,
    });

    expect(second.status).toBe("ok");
    expect(second.status === "ok" ? second.source : "unexpected").toBe("cache");
    expect(captureSnapshot).toHaveBeenCalledTimes(1);
  });

  it("invalidates the snapshot when config changes", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chatgpt-apps-"));
    const env = {
      OPENCLAW_STATE_DIR: tempRoot,
      HOME: tempRoot,
    };
    const captureSnapshot = vi.fn(async () => createCapture());

    await ensureFreshSnapshot({
      loadOpenClawConfig: () => createConfig({ slack: { enabled: true } }),
      env,
      now: () => new Date("2026-03-29T18:01:00.000Z").getTime(),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      captureSnapshot,
    });

    await ensureFreshSnapshot({
      loadOpenClawConfig: () => createConfig({ slack: { enabled: false } }),
      env,
      now: () => new Date("2026-03-29T19:00:00.000Z").getTime(),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      captureSnapshot,
    });

    expect(captureSnapshot).toHaveBeenCalledTimes(2);
  });

  it("preserves the last good snapshot when refresh fails", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chatgpt-apps-"));
    const env = {
      OPENCLAW_STATE_DIR: tempRoot,
      HOME: tempRoot,
    };
    const statePaths = resolveChatgptAppsStatePaths(env);

    await ensureFreshSnapshot({
      loadOpenClawConfig: () => createConfig(),
      env,
      now: () => new Date("2026-03-29T18:01:00.000Z").getTime(),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      captureSnapshot: async () => createCapture(),
    });

    const failed = await ensureFreshSnapshot({
      loadOpenClawConfig: () => createConfig(),
      env,
      hardRefresh: true,
      now: () => new Date("2026-03-29T18:30:00.000Z").getTime(),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      captureSnapshot: async () => {
        throw new Error("sidecar launch failed");
      },
    });

    expect(failed).toMatchObject({
      status: "error",
      reason: "refresh",
      message: "sidecar launch failed",
    });
    const snapshot = await readPersistedSnapshot(statePaths.snapshotPath);
    expect(snapshot?.accountId).toBe("acct_123");
  });

  it("times out hung refresh captures instead of blocking indefinitely", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chatgpt-apps-"));
    const env = {
      OPENCLAW_STATE_DIR: tempRoot,
      HOME: tempRoot,
    };

    const result = await ensureFreshSnapshot({
      loadOpenClawConfig: () => createConfig(),
      env,
      refreshTimeoutMs: 5,
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      captureSnapshot: async () => await new Promise<AppServerRefreshCapture>(() => {}),
    });

    expect(result).toMatchObject({
      status: "error",
      reason: "refresh",
      message: "Timed out refreshing ChatGPT apps snapshot",
    });
  });
});
