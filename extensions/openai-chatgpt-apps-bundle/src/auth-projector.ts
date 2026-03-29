import { refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  ensureAuthProfileStore,
  type OAuthCredential,
  upsertAuthProfileWithLock,
} from "openclaw/plugin-sdk/provider-auth";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { resolveCodexAuthIdentity } from "./openai-codex-auth-identity.js";

export type ChatgptAppsResolvedAuth =
  | {
      status: "ok";
      accessToken: string;
      accountId: string;
      planType: string | null;
      identity: ReturnType<typeof resolveCodexAuthIdentity>;
      profileId: string;
    }
  | {
      status: "missing-auth";
      message: string;
    }
  | {
      status: "missing-account-id";
      message: string;
      accessToken: string;
      identity: ReturnType<typeof resolveCodexAuthIdentity>;
      profileId: string;
    }
  | {
      status: "error";
      message: string;
    };

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveStoredOauthCredential(params: { config: OpenClawConfig; agentDir?: string }): {
  profileId: string | null;
  credential: OAuthCredential | null;
} {
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const defaultProfileId =
    typeof store.profiles?.["openai-codex:default"]?.provider === "string" &&
    store.profiles["openai-codex:default"].provider === "openai-codex"
      ? "openai-codex:default"
      : null;
  const profileId =
    defaultProfileId ??
    Object.entries(store.profiles ?? {}).find(
      ([, credential]) =>
        credential?.type === "oauth" &&
        typeof credential.provider === "string" &&
        credential.provider === "openai-codex",
    )?.[0] ??
    null;
  if (!profileId) {
    return { profileId: null, credential: null };
  }

  const credential = store.profiles[profileId];
  if (credential?.type !== "oauth") {
    return { profileId, credential: null };
  }

  const accessToken = normalizeOptionalString(credential.access);
  if (!accessToken) {
    return { profileId, credential: null };
  }

  return {
    profileId,
    credential: {
      ...credential,
      access: accessToken,
      accountId:
        credential?.type === "oauth" ? normalizeOptionalString(credential.accountId) : undefined,
      email: credential?.type === "oauth" ? normalizeOptionalString(credential.email) : undefined,
      displayName:
        credential?.type === "oauth" ? normalizeOptionalString(credential.displayName) : undefined,
    },
  };
}

function shouldRefreshOauthCredential(credential: OAuthCredential): boolean {
  const refreshToken = normalizeOptionalString(credential.refresh);
  if (!refreshToken) {
    return false;
  }
  if (!normalizeOptionalString(credential.access)) {
    return true;
  }
  const expiresAt = typeof credential.expires === "number" ? credential.expires : null;
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  return (expiresAt as number) <= Date.now() + 60_000;
}

async function resolveFreshOauthCredential(params: {
  agentDir?: string;
  profileId: string;
  credential: OAuthCredential;
}): Promise<OAuthCredential> {
  if (!shouldRefreshOauthCredential(params.credential)) {
    return params.credential;
  }

  const refreshToken = normalizeOptionalString(params.credential.refresh);
  if (!refreshToken) {
    return params.credential;
  }

  try {
    ensureGlobalUndiciEnvProxyDispatcher();
    const refreshed = await refreshOpenAICodexToken(refreshToken);
    const nextCredential: OAuthCredential = {
      ...params.credential,
      type: "oauth",
      provider: "openai-codex",
      access: refreshed.access,
      refresh: normalizeOptionalString(refreshed.refresh) ?? refreshToken,
      expires: refreshed.expires,
      accountId: normalizeOptionalString(refreshed.accountId) ?? params.credential.accountId,
      email: params.credential.email,
      displayName: params.credential.displayName,
    };
    await upsertAuthProfileWithLock({
      agentDir: params.agentDir,
      profileId: params.profileId,
      credential: nextCredential,
    });
    return nextCredential;
  } catch {
    return params.credential;
  }
}

export async function resolveChatgptAppsProjectedAuth(params: {
  config: OpenClawConfig;
  agentDir?: string;
}): Promise<ChatgptAppsResolvedAuth> {
  try {
    const initial = resolveStoredOauthCredential(params);
    const profileId = initial.profileId;
    if (!profileId) {
      return {
        status: "missing-auth",
        message: "OpenAI Codex OAuth is not configured in OpenClaw.",
      };
    }

    const storedCredential = initial.credential;
    if (!storedCredential) {
      return {
        status: "missing-auth",
        message: "OpenAI Codex OAuth is not configured in OpenClaw.",
      };
    }

    const resolved = await resolveFreshOauthCredential({
      agentDir: params.agentDir,
      profileId,
      credential: storedCredential,
    });
    if (!normalizeOptionalString(resolved.access)) {
      return {
        status: "missing-auth",
        message: "OpenAI Codex OAuth is not configured in OpenClaw.",
      };
    }

    const accessToken = resolved.access;
    const identity = resolveCodexAuthIdentity({
      accessToken,
      email: normalizeOptionalString(resolved.email),
    });
    const accountId = normalizeOptionalString(resolved.accountId);

    if (!accountId) {
      return {
        status: "missing-account-id",
        message:
          "OpenAI Codex OAuth is present, but the credential does not expose a ChatGPT account id. Re-login with openai-codex before enabling ChatGPT apps.",
        accessToken,
        identity,
        profileId,
      };
    }

    return {
      status: "ok",
      accessToken,
      accountId,
      planType: null,
      identity,
      profileId,
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
