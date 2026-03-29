import {
  ensureAuthProfileStore,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
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

export async function resolveChatgptAppsProjectedAuth(params: {
  config: OpenClawConfig;
  agentDir?: string;
}): Promise<ChatgptAppsResolvedAuth> {
  try {
    const store = ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
    const profileOrder = resolveAuthProfileOrder({
      cfg: params.config,
      store,
      provider: "openai-codex",
    });
    const profileId = profileOrder[0];

    if (!profileId) {
      return {
        status: "missing-auth",
        message: "OpenAI Codex OAuth is not configured in OpenClaw.",
      };
    }

    await resolveApiKeyForProfile({
      cfg: params.config,
      store,
      profileId,
      agentDir: params.agentDir,
    });

    const refreshedStore = ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
    const credential = refreshedStore.profiles[profileId];

    if (!credential || credential.type !== "oauth" || !normalizeOptionalString(credential.access)) {
      return {
        status: "missing-auth",
        message: "OpenAI Codex OAuth is not configured in OpenClaw.",
      };
    }

    const accessToken = credential.access;
    const identity = resolveCodexAuthIdentity({
      accessToken,
      email: credential.email,
    });
    const accountId = normalizeOptionalString(credential.accountId);

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
