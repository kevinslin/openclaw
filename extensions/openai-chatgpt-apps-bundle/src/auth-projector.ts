import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { ensureAuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
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
  credential: {
    accessToken: string;
    accountId?: string;
    email?: string;
  } | null;
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
  const accessToken =
    credential?.type === "oauth" ? normalizeOptionalString(credential.access) : undefined;
  if (!accessToken) {
    return { profileId, credential: null };
  }

  return {
    profileId,
    credential: {
      accessToken,
      accountId:
        credential?.type === "oauth" ? normalizeOptionalString(credential.accountId) : undefined,
      email: credential?.type === "oauth" ? normalizeOptionalString(credential.email) : undefined,
    },
  };
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

    const resolved = initial.credential;
    if (!resolved?.accessToken) {
      return {
        status: "missing-auth",
        message: "OpenAI Codex OAuth is not configured in OpenClaw.",
      };
    }

    const accessToken = resolved.accessToken;
    const identity = resolveCodexAuthIdentity({
      accessToken,
      email: resolved.email,
    });
    const accountId = resolved.accountId;

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
