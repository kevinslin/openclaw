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
        "openai-apps": {
          config: {
            enabled: true,
            connectors: connectors ?? {},
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createCapture(): AppServerRefreshCapture {
  return {
    apps: [
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
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openai-apps-"));
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

  it("reuses the snapshot when config changes", async () => {
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

    const second = await ensureFreshSnapshot({
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

    expect(second.status).toBe("ok");
    expect(second.status === "ok" ? second.source : "unexpected").toBe("cache");
    expect(captureSnapshot).toHaveBeenCalledTimes(1);
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

  it("invalidates an old v1 snapshot and rewrites it as connector metadata", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chatgpt-apps-"));
    const env = {
      OPENCLAW_STATE_DIR: tempRoot,
      HOME: tempRoot,
    };
    const statePaths = resolveChatgptAppsStatePaths(env);
    await fs.mkdir(path.dirname(statePaths.snapshotPath), { recursive: true });
    await fs.writeFile(
      statePaths.snapshotPath,
      `${JSON.stringify(
        {
          version: 1,
          fetchedAt: "2026-03-29T18:00:00.000Z",
          projectedAt: "2026-03-29T18:00:00.000Z",
          accountId: "acct_123",
          authIdentityKey: "user@example.com",
        },
        null,
        2,
      )}\n`,
    );

    const captureSnapshot = vi.fn(async () => createCapture());
    const result = await ensureFreshSnapshot({
      loadOpenClawConfig: () => createConfig(),
      env,
      now: () => new Date("2026-03-30T18:01:00.000Z").getTime(),
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

    expect(result.status).toBe("ok");
    expect(result.status === "ok" ? result.source : "unexpected").toBe("refresh");
    expect(captureSnapshot).toHaveBeenCalledTimes(1);
    const snapshot = await readPersistedSnapshot(statePaths.snapshotPath);
    expect(snapshot?.version).toBe(2);
    expect(snapshot?.connectors.map((connector) => connector.connectorId)).toEqual(["slack"]);
  });
});
