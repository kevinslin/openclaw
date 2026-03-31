import { createHash } from "node:crypto";
import type { protocol } from "codex-app-server-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

type AppsDefaultConfig = protocol.v2.AppsDefaultConfig;
type DerivedAppConfig = {
  enabled: boolean;
  destructive_enabled: boolean;
  open_world_enabled: boolean;
  default_tools_approval_mode?: protocol.v2.AppToolApproval | null;
  default_tools_enabled?: boolean | null;
  tools?: protocol.v2.AppToolsConfig | null;
};
type DerivedAppsConfig = {
  _default: AppsDefaultConfig;
} & Record<string, DerivedAppConfig>;

const DEFAULT_APP_SERVER_COMMAND = "codex";
const DEFAULT_ALLOW_DESTRUCTIVE_ACTIONS = "never";

export type AllowDestructiveActionsMode = "always" | "on-request" | "never";

export type ChatgptAppsConfig = {
  enabled: boolean;
  allowDestructiveActions: AllowDestructiveActionsMode;
  appServer: {
    command: string;
    args: string[];
  };
  connectors: Record<string, { enabled: boolean }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeAppServerArgs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .filter((entry) => entry !== "app-server" && entry !== "--analytics-default-enabled");
}

function normalizeAllowDestructiveActions(value: unknown): AllowDestructiveActionsMode {
  if (value === "always" || value === "on-request" || value === "never") {
    return value;
  }
  return DEFAULT_ALLOW_DESTRUCTIVE_ACTIONS;
}

function normalizeConnectors(value: unknown): ChatgptAppsConfig["connectors"] {
  if (!isRecord(value)) {
    return {};
  }
  const normalized: ChatgptAppsConfig["connectors"] = {};
  for (const [connectorId, entry] of Object.entries(value)) {
    const trimmedId = connectorId.trim();
    if (!trimmedId) {
      continue;
    }
    normalized[trimmedId] = {
      enabled: !isRecord(entry) || typeof entry.enabled !== "boolean" ? true : entry.enabled,
    };
  }
  return normalized;
}

export function resolveOpenaiAppsPluginConfig(config: OpenClawConfig): unknown {
  return config.plugins?.entries?.["openai-apps"]?.config ?? {};
}

export function resolveChatgptAppsConfig(pluginConfig: unknown): ChatgptAppsConfig {
  const raw = isRecord(pluginConfig) ? pluginConfig : {};
  const appServer = isRecord(raw.appServer) ? raw.appServer : {};

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
    allowDestructiveActions: normalizeAllowDestructiveActions(raw.allow_destructive_actions),
    appServer: {
      command: normalizeNonEmptyString(appServer.command) ?? DEFAULT_APP_SERVER_COMMAND,
      args: normalizeAppServerArgs(appServer.args),
    },
    connectors: normalizeConnectors(raw.connectors),
  };
}

export function buildDerivedAppsConfig(config: ChatgptAppsConfig): DerivedAppsConfig {
  const apps: Record<string, DerivedAppConfig> = {};
  const wildcardEnabled = config.connectors["*"]?.enabled ?? false;
  // Keep destructive tools visible even when OpenClaw is configured to block
  // them. The outer invoker handles destructive elicitations centrally and
  // returns the policy-specific response for allowDestructiveActions=never.
  const destructiveEnabled = true;

  for (const [connectorId, connector] of Object.entries(config.connectors)) {
    if (connectorId === "*") {
      continue;
    }
    apps[connectorId] = {
      enabled: connector.enabled,
      // The app-server persists this structure via TOML-backed config writes.
      // Omit optional null-valued keys so the sidecar never attempts to encode
      // JSON null into a TOML value.
      destructive_enabled: destructiveEnabled,
      open_world_enabled: true,
    };
  }

  return {
    _default: {
      enabled: wildcardEnabled,
      destructive_enabled: destructiveEnabled,
      open_world_enabled: true,
    },
    ...apps,
  };
}

export function hashChatgptAppsConfig(config: ChatgptAppsConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
