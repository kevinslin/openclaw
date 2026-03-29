import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  upsertAuthProfileWithLock: vi.fn(),
}));

const oauthMocks = vi.hoisted(() => ({
  refreshOpenAICodexToken: vi.fn(),
}));

const runtimeEnvMocks = vi.hoisted(() => ({
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
}));

const identityMocks = vi.hoisted(() => ({
  resolveCodexAuthIdentity: vi.fn(() => ({
    email: "kevinlin@openai.com",
    profileName: "kevinlin@openai.com",
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  ensureAuthProfileStore: authMocks.ensureAuthProfileStore,
  upsertAuthProfileWithLock: authMocks.upsertAuthProfileWithLock,
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  refreshOpenAICodexToken: oauthMocks.refreshOpenAICodexToken,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: runtimeEnvMocks.ensureGlobalUndiciEnvProxyDispatcher,
}));

vi.mock("./openai-codex-auth-identity.js", () => ({
  resolveCodexAuthIdentity: identityMocks.resolveCodexAuthIdentity,
}));

import { resolveChatgptAppsProjectedAuth } from "./auth-projector.js";

describe("resolveChatgptAppsProjectedAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes the stored Codex OAuth credential before projecting auth", async () => {
    authMocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "stale-access",
          refresh: "refresh-token",
          accountId: "acct_stale",
          email: "kevinlin@openai.com",
          displayName: "Kevin Lin",
          expires: 1,
        },
      },
    });
    oauthMocks.refreshOpenAICodexToken.mockResolvedValue({
      access: "fresh-access",
      accountId: "acct_fresh",
      expires: 2,
    });
    authMocks.upsertAuthProfileWithLock.mockResolvedValue(null);

    const result = await resolveChatgptAppsProjectedAuth({
      config: {},
      agentDir: "/tmp/agent",
    });

    expect(runtimeEnvMocks.ensureGlobalUndiciEnvProxyDispatcher).toHaveBeenCalledTimes(1);
    expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("refresh-token");
    expect(authMocks.upsertAuthProfileWithLock).toHaveBeenCalledWith({
      agentDir: "/tmp/agent",
      profileId: "openai-codex:default",
      credential: expect.objectContaining({
        type: "oauth",
        provider: "openai-codex",
        access: "fresh-access",
        refresh: "refresh-token",
        accountId: "acct_fresh",
        email: "kevinlin@openai.com",
        displayName: "Kevin Lin",
        expires: 2,
      }),
    });
    expect(result).toEqual({
      status: "ok",
      accessToken: "fresh-access",
      accountId: "acct_fresh",
      planType: null,
      identity: {
        email: "kevinlin@openai.com",
        profileName: "kevinlin@openai.com",
      },
      profileId: "openai-codex:default",
    });
  });

  it("uses the stored credential directly when it is still fresh", async () => {
    authMocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "stored-access",
          refresh: "refresh-token",
          accountId: "acct_stored",
          email: "kevinlin@openai.com",
          expires: Date.now() + 10 * 60_000,
        },
      },
    });

    const result = await resolveChatgptAppsProjectedAuth({
      config: {},
      agentDir: "/tmp/agent",
    });

    expect(runtimeEnvMocks.ensureGlobalUndiciEnvProxyDispatcher).not.toHaveBeenCalled();
    expect(oauthMocks.refreshOpenAICodexToken).not.toHaveBeenCalled();
    expect(authMocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "ok",
      accessToken: "stored-access",
      accountId: "acct_stored",
      planType: null,
      identity: {
        email: "kevinlin@openai.com",
        profileName: "kevinlin@openai.com",
      },
      profileId: "openai-codex:default",
    });
  });

  it("falls back to the stored credential when refresh fails", async () => {
    authMocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "stored-access",
          refresh: "refresh-token",
          accountId: "acct_stored",
          email: "kevinlin@openai.com",
          expires: 1,
        },
      },
    });
    oauthMocks.refreshOpenAICodexToken.mockRejectedValue(new Error("refresh failed"));

    const result = await resolveChatgptAppsProjectedAuth({
      config: {},
      agentDir: "/tmp/agent",
    });

    expect(authMocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "ok",
      accessToken: "stored-access",
      accountId: "acct_stored",
      planType: null,
      identity: {
        email: "kevinlin@openai.com",
        profileName: "kevinlin@openai.com",
      },
      profileId: "openai-codex:default",
    });
  });
});
