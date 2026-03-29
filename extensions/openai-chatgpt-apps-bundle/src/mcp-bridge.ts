import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { protocol } from "codex-sdk-ts";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveChatgptAppsProjectedAuth } from "./auth-projector.js";
import { hashChatgptAppsConfig, hashChatgptBaseUrl, resolveChatgptAppsConfig } from "./config.js";
import { ensureFreshSnapshot, type EnsureFreshSnapshotResult } from "./refresh-snapshot.js";
import {
  createRemoteCodexAppsClient,
  type RemoteCodexAppsClient,
  type RemoteCodexAppsClientFactory,
} from "./remote-codex-apps-client.js";
import {
  computeSnapshotKey,
  readPersistedSnapshot,
  type PersistedConnectorSnapshot,
} from "./snapshot-cache.js";
import { resolveChatgptAppsStatePaths } from "./state-paths.js";

type AppInfo = protocol.v2.AppInfo;
type McpServerStatus = protocol.v2.McpServerStatus;
type RemoteTool = protocol.Tool;

export const MCP_SERVER_NAME = "openai-chatgpt-apps";
const ROUTING_META_KEY = "openclaw/chatgpt-apps";
const INITIAL_WILDCARD_REFRESH_TIMEOUT_MS = 20_000;

type BridgeRoute = {
  connectorId: string;
  remoteName: string;
  remoteMeta?: Record<string, unknown>;
};

type BridgeToolCache = {
  snapshotKey: string;
  tools: Tool[];
  routes: Map<string, BridgeRoute>;
};

type PublicationState =
  | {
      kind: "snapshot";
      config: ReturnType<typeof resolveChatgptAppsConfig>;
      snapshot: PersistedConnectorSnapshot;
    }
  | {
      kind: "degraded";
      config: ReturnType<typeof resolveChatgptAppsConfig>;
    };

type McpToolSchema = Tool["inputSchema"] & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function sanitizeJsonSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonSchemaNode(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(value[combinator]) && value[combinator].length > 0) {
      const preferredBranch =
        value[combinator].find((entry) => !(isRecord(entry) && entry.type === "null")) ??
        value[combinator][0];
      const sanitizedBranch = sanitizeJsonSchemaNode(preferredBranch);
      if (!isRecord(sanitizedBranch)) {
        return sanitizedBranch;
      }

      const merged = { ...sanitizedBranch };
      if (!("title" in merged) && typeof value.title === "string") {
        merged.title = value.title;
      }
      if (!("description" in merged) && typeof value.description === "string") {
        merged.description = value.description;
      }
      if (!("default" in merged) && value.default !== null && value.default !== undefined) {
        merged.default = sanitizeJsonSchemaNode(value.default);
      }
      return merged;
    }
  }

  const sanitized: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeJsonSchemaNode(entry)]),
  );

  if (sanitized.default === null) {
    delete sanitized.default;
  } else if ("default" in sanitized) {
    sanitized.default = sanitizeJsonSchemaNode(sanitized.default);
  }

  const schemaType = sanitized.type;
  const hasValidType =
    (typeof schemaType === "string" && JSON_SCHEMA_TYPES.has(schemaType)) ||
    (Array.isArray(schemaType) &&
      schemaType.every((entry) => typeof entry === "string" && JSON_SCHEMA_TYPES.has(entry)));
  if (!hasValidType) {
    if (isRecord(sanitized.properties)) {
      sanitized.type = "object";
    } else if ("items" in sanitized) {
      sanitized.type = "array";
    } else {
      sanitized.type = "object";
      sanitized.additionalProperties =
        typeof sanitized.additionalProperties === "boolean" ? sanitized.additionalProperties : true;
    }
  }

  delete sanitized.anyOf;
  delete sanitized.oneOf;
  delete sanitized.allOf;

  return sanitized;
}

function sanitizeToolSchema(inputSchema: unknown): McpToolSchema {
  const sanitized = sanitizeJsonSchemaNode(inputSchema);
  if (!isRecord(sanitized)) {
    return {
      type: "object",
      additionalProperties: true,
    } as McpToolSchema;
  }

  const properties = isRecord(sanitized.properties)
    ? Object.fromEntries(
        Object.entries(sanitized.properties).flatMap(([key, value]) =>
          isRecord(value) ? [[key, value as object]] : [],
        ),
      )
    : undefined;
  const required = Array.isArray(sanitized.required)
    ? sanitized.required.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  const normalizedSchema = {
    ...sanitized,
    type: "object",
    ...(properties ? { properties } : {}),
    ...(required ? { required } : {}),
  } as McpToolSchema;

  if (!isValidSanitizedJsonSchemaNode(normalizedSchema)) {
    return {
      type: "object",
      additionalProperties: true,
    } as McpToolSchema;
  }

  return normalizedSchema;
}

function isValidSanitizedJsonSchemaNode(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every((entry) => isValidSanitizedJsonSchemaNode(entry));
  }

  if (!isRecord(value)) {
    return true;
  }

  for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
    if (combinator in value) {
      return false;
    }
  }

  if ("type" in value) {
    const schemaType = value.type;
    const validType =
      (typeof schemaType === "string" && JSON_SCHEMA_TYPES.has(schemaType)) ||
      (Array.isArray(schemaType) &&
        schemaType.every((entry) => typeof entry === "string" && JSON_SCHEMA_TYPES.has(entry)));
    if (!validType) {
      return false;
    }
  }

  return Object.values(value).every((entry) => isValidSanitizedJsonSchemaNode(entry));
}

function sanitizeToolAnnotations(annotations: unknown): Tool["annotations"] | undefined {
  if (!isRecord(annotations)) {
    return undefined;
  }

  const sanitized: NonNullable<Tool["annotations"]> = {};
  if (typeof annotations.title === "string") {
    sanitized.title = annotations.title;
  }
  if (typeof annotations.readOnlyHint === "boolean") {
    sanitized.readOnlyHint = annotations.readOnlyHint;
  }
  if (typeof annotations.destructiveHint === "boolean") {
    sanitized.destructiveHint = annotations.destructiveHint;
  }
  if (typeof annotations.idempotentHint === "boolean") {
    sanitized.idempotentHint = annotations.idempotentHint;
  }
  if (typeof annotations.openWorldHint === "boolean") {
    sanitized.openWorldHint = annotations.openWorldHint;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeToolIcons(icons: unknown): Tool["icons"] | undefined {
  if (!Array.isArray(icons)) {
    return undefined;
  }

  const sanitizedIcons = icons.flatMap((icon) => {
    if (!isRecord(icon) || typeof icon.src !== "string") {
      return [];
    }

    const sanitizedIcon: NonNullable<Tool["icons"]>[number] = {
      src: icon.src,
    };
    if (typeof icon.mimeType === "string") {
      sanitizedIcon.mimeType = icon.mimeType;
    }
    if (Array.isArray(icon.sizes)) {
      sanitizedIcon.sizes = icon.sizes.filter((size): size is string => typeof size === "string");
    }
    if (icon.theme === "light" || icon.theme === "dark") {
      sanitizedIcon.theme = icon.theme;
    }
    return [sanitizedIcon];
  });

  return sanitizedIcons.length > 0 ? sanitizedIcons : undefined;
}

function rewriteToolName(connectorId: string, remoteToolName: string): string {
  return `chatgpt_app__${connectorId}__${remoteToolName}`;
}

function normalizeConnectorKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function looksLikeOpaqueAppId(value: string): boolean {
  return value.startsWith("connector_") || value.startsWith("asdk_app_");
}

function deriveConnectorKeysFromApp(app: AppInfo): string[] {
  const candidates = new Set<string>();

  if (!looksLikeOpaqueAppId(app.id)) {
    const normalizedId = normalizeConnectorKey(app.id);
    if (normalizedId) {
      candidates.add(normalizedId);
    }
  }

  for (const value of [app.name, ...app.pluginDisplayNames]) {
    const normalized = normalizeConnectorKey(value);
    if (normalized) {
      candidates.add(normalized);
    }
  }

  return [...candidates];
}

function resolveConnectorIdForRemoteToolName(
  remoteToolName: string,
  allowedConnectorIds: Set<string>,
): string | null {
  const sortedConnectorIds = [...allowedConnectorIds].sort(
    (left, right) => right.length - left.length,
  );
  for (const connectorId of sortedConnectorIds) {
    if (remoteToolName === connectorId || remoteToolName.startsWith(`${connectorId}_`)) {
      return connectorId;
    }
  }
  return null;
}

function resolveConnectorIdFromRemoteToolMetadata(
  remoteTool: Pick<RemoteTool, "name" | "_meta">,
): string | null {
  const meta = isRecord(remoteTool._meta) ? remoteTool._meta : undefined;
  const connectorId =
    typeof meta?.connector_id === "string" ? normalizeConnectorKey(meta.connector_id) : "";
  if (connectorId) {
    return connectorId;
  }

  const codexAppsMeta = isRecord(meta?._codex_apps) ? meta._codex_apps : undefined;
  const resourceUri =
    typeof codexAppsMeta?.resource_uri === "string" ? codexAppsMeta.resource_uri : "";
  const resourceMatch = /^connectors:\/\/([^/]+)\/tools\//.exec(resourceUri);
  if (!resourceMatch?.[1]) {
    return null;
  }

  const normalized = normalizeConnectorKey(resourceMatch[1]);
  return normalized || null;
}

function buildRemoteToolPrefixCounts(remoteTools: Pick<RemoteTool, "name">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const remoteTool of remoteTools) {
    const tokens = normalizeConnectorKey(remoteTool.name)
      .split("_")
      .filter((token) => token.length > 0);
    for (let prefixLength = 1; prefixLength < tokens.length; prefixLength += 1) {
      const prefix = tokens.slice(0, prefixLength).join("_");
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return counts;
}

function resolveConnectorIdFromRemoteToolNamePrefix(
  remoteToolName: string,
  prefixCounts: Map<string, number>,
): string | null {
  const tokens = normalizeConnectorKey(remoteToolName)
    .split("_")
    .filter((token) => token.length > 0);
  let longestRepeatedPrefix: string | null = null;

  for (let prefixLength = 1; prefixLength < tokens.length; prefixLength += 1) {
    const prefix = tokens.slice(0, prefixLength).join("_");
    if ((prefixCounts.get(prefix) ?? 0) >= 2) {
      longestRepeatedPrefix = prefix;
    }
  }

  return longestRepeatedPrefix ?? tokens[0] ?? null;
}

function buildConnectorConfigState(configuredConnectors: Record<string, { enabled: boolean }>): {
  wildcardEnabled: boolean;
  enabledConnectorIds: Set<string>;
  disabledConnectorIds: Set<string>;
} {
  let wildcardEnabled = false;
  const enabledConnectorIds = new Set<string>();
  const disabledConnectorIds = new Set<string>();

  for (const [connectorId, connector] of Object.entries(configuredConnectors)) {
    const trimmedId = connectorId.trim();
    if (!trimmedId) {
      continue;
    }
    if (trimmedId === "*") {
      wildcardEnabled = connector.enabled === true;
      continue;
    }
    const normalized = normalizeConnectorKey(trimmedId);
    if (!normalized) {
      continue;
    }
    if (connector.enabled) {
      enabledConnectorIds.add(normalized);
      continue;
    }
    disabledConnectorIds.add(normalized);
  }

  return {
    wildcardEnabled,
    enabledConnectorIds,
    disabledConnectorIds,
  };
}

function buildAllowedConnectorIds(params: {
  inventory: AppInfo[];
  configuredConnectors: Record<string, { enabled: boolean }>;
}): Set<string> {
  const { wildcardEnabled, enabledConnectorIds, disabledConnectorIds } = buildConnectorConfigState(
    params.configuredConnectors,
  );

  if (Object.keys(params.configuredConnectors).length > 0) {
    const allowed = new Set<string>();
    for (const app of params.inventory) {
      if (!app.isAccessible) {
        continue;
      }
      for (const connectorId of deriveConnectorKeysFromApp(app)) {
        if (disabledConnectorIds.has(connectorId)) {
          continue;
        }
        if (wildcardEnabled || enabledConnectorIds.has(connectorId)) {
          allowed.add(connectorId);
        }
      }
    }
    return allowed;
  }

  const allowed = new Set<string>();
  for (const app of params.inventory) {
    if (!app.isAccessible) {
      continue;
    }
    for (const connectorId of deriveConnectorKeysFromApp(app)) {
      allowed.add(connectorId);
    }
  }
  return allowed;
}

function buildConfiguredConnectorIds(
  configuredConnectors: Record<string, { enabled: boolean }>,
): Set<string> {
  return buildConnectorConfigState(configuredConnectors).enabledConnectorIds;
}

function buildRemoteToolConnectorMap(params: {
  statuses: McpServerStatus[];
  allowedConnectorIds: Set<string>;
}): Map<string, string> {
  const toolToConnector = new Map<string, string>();

  for (const status of params.statuses) {
    for (const [toolName, tool] of Object.entries(status.tools ?? {})) {
      const remoteTool = tool as RemoteTool | undefined;
      const resolvedName = remoteTool?.name ?? toolName;
      if (!resolvedName || toolToConnector.has(resolvedName)) {
        continue;
      }

      const normalizedStatusName = normalizeConnectorKey(status.name);
      const connectorId = params.allowedConnectorIds.has(normalizedStatusName)
        ? normalizedStatusName
        : resolveConnectorIdForRemoteToolName(resolvedName, params.allowedConnectorIds);
      if (!connectorId) {
        continue;
      }
      toolToConnector.set(resolvedName, connectorId);
    }
  }

  return toolToConnector;
}

function withRoutingMetadata(tool: RemoteTool, route: BridgeRoute): Tool {
  const existingMeta = isRecord(tool._meta) ? tool._meta : {};
  const outputSchema =
    tool.outputSchema === undefined ? undefined : sanitizeToolSchema(tool.outputSchema);
  return {
    ...tool,
    name: rewriteToolName(route.connectorId, route.remoteName),
    inputSchema: sanitizeToolSchema(tool.inputSchema),
    outputSchema,
    annotations: sanitizeToolAnnotations(tool.annotations),
    icons: sanitizeToolIcons(tool.icons),
    _meta: {
      ...existingMeta,
      [ROUTING_META_KEY]: {
        connectorId: route.connectorId,
        remoteName: route.remoteName,
      },
    },
  };
}

function mergeToolCallMeta(
  meta: Record<string, unknown> | undefined,
  remoteMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!remoteMeta || Object.keys(remoteMeta).length === 0) {
    return meta;
  }

  const existingMeta = isRecord(meta) ? meta : {};
  return {
    ...existingMeta,
    ...remoteMeta,
  };
}

export class ChatgptAppsMcpBridge {
  private readonly server: Server;
  private readonly loadOpenClawConfig: () => OpenClawConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly workspaceDir?: string;
  private readonly ensureFreshSnapshot;
  private readonly resolveProjectedAuth;
  private readonly remoteClientFactory: RemoteCodexAppsClientFactory;
  private hardRefreshRequested: boolean;
  private remoteClientState: {
    authKey: string;
    client: RemoteCodexAppsClient;
  } | null = null;
  private remoteClientPromise: Promise<RemoteCodexAppsClient> | null = null;
  private toolCache: BridgeToolCache | null = null;
  private toolCachePromise: Promise<BridgeToolCache> | null = null;
  private backgroundRefreshPromise: Promise<void> | null = null;

  constructor(params: {
    loadOpenClawConfig: () => OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    hardRefresh?: boolean;
    ensureFreshSnapshot?: typeof ensureFreshSnapshot;
    resolveProjectedAuth?: typeof resolveChatgptAppsProjectedAuth;
    remoteClientFactory?: RemoteCodexAppsClientFactory;
  }) {
    this.loadOpenClawConfig = params.loadOpenClawConfig;
    this.env = params.env ?? process.env;
    this.workspaceDir = params.workspaceDir;
    this.hardRefreshRequested = params.hardRefresh ?? false;
    this.ensureFreshSnapshot = params.ensureFreshSnapshot ?? ensureFreshSnapshot;
    this.resolveProjectedAuth = params.resolveProjectedAuth ?? resolveChatgptAppsProjectedAuth;
    this.remoteClientFactory = params.remoteClientFactory ?? createRemoteCodexAppsClient;

    this.server = new Server(
      {
        name: MCP_SERVER_NAME,
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
      },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      if (request.params?.cursor) {
        return { tools: [] };
      }
      return {
        tools: await this.listTools(),
      };
    });

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> =>
        await this.callTool(request.params.name, request.params.arguments, request.params._meta),
    );
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    this.toolCache = null;
    this.toolCachePromise = null;

    const remoteState = this.remoteClientState;
    this.remoteClientState = null;
    this.remoteClientPromise = null;
    if (remoteState) {
      await remoteState.client.close();
    }

    await this.server.close();
  }

  async listTools(): Promise<Tool[]> {
    const publicationState = await this.getPublicationState();
    this.scheduleBackgroundRefresh();
    const cache = await this.getToolCache(publicationState);
    return cache.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    meta?: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const publicationState = await this.getPublicationState();
    this.scheduleBackgroundRefresh();
    let cache = await this.getToolCache(publicationState);
    let route = cache.routes.get(name);
    if (!route) {
      this.invalidateToolCache();
      cache = await this.getToolCache({
        kind: "degraded",
        config: publicationState.config,
      });
      route = cache.routes.get(name);
    }
    if (!route) {
      throw new Error(`Unknown ChatGPT app tool: ${name}`);
    }

    const auth = await this.resolveProjectedAuth({
      config: this.loadOpenClawConfig(),
      agentDir: this.env.OPENCLAW_AGENT_DIR,
    });
    if (auth.status !== "ok") {
      throw new Error(auth.message);
    }

    const remoteClient = await this.getRemoteClient({
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      chatgptBaseUrl: publicationState.config.chatgptBaseUrl,
    });
    return await remoteClient.callTool({
      name: route.remoteName,
      arguments: args,
      _meta: mergeToolCallMeta(meta, route.remoteMeta),
    });
  }

  private consumeHardRefresh(): boolean {
    const hardRefresh = this.hardRefreshRequested;
    this.hardRefreshRequested = false;
    return hardRefresh;
  }

  private invalidateToolCache(): void {
    this.toolCache = null;
    this.toolCachePromise = null;
  }

  private async getPublicationState(): Promise<PublicationState> {
    const openclawConfig = this.loadOpenClawConfig();
    const config = resolveChatgptAppsConfig(openclawConfig.plugins?.entries?.openai?.config ?? {});
    const statePaths = resolveChatgptAppsStatePaths(this.env);
    const snapshot = await readPersistedSnapshot(statePaths.snapshotPath);
    if (snapshot) {
      return {
        kind: "snapshot",
        config,
        snapshot,
      };
    }

    const { wildcardEnabled } = buildConnectorConfigState(config.connectors);
    if (wildcardEnabled) {
      const refreshResult = await this.ensureFreshSnapshot({
        loadOpenClawConfig: this.loadOpenClawConfig,
        env: this.env,
        workspaceDir: this.workspaceDir,
        hardRefresh: this.consumeHardRefresh(),
        refreshTimeoutMs: INITIAL_WILDCARD_REFRESH_TIMEOUT_MS,
      });
      if (refreshResult.status === "ok") {
        return {
          kind: "snapshot",
          config: refreshResult.config,
          snapshot: refreshResult.snapshot,
        };
      }
    }

    return {
      kind: "degraded",
      config,
    };
  }

  private async getRemoteClient(params: {
    accessToken: string;
    accountId: string;
    chatgptBaseUrl: string;
  }): Promise<RemoteCodexAppsClient> {
    const authKey = `${params.accountId}:${params.accessToken}`;
    if (this.remoteClientState?.authKey === authKey) {
      return this.remoteClientState.client;
    }
    if (this.remoteClientPromise) {
      return await this.remoteClientPromise;
    }

    const previous = this.remoteClientState;
    this.remoteClientState = null;
    this.remoteClientPromise = this.remoteClientFactory({
      chatgptBaseUrl: params.chatgptBaseUrl,
      auth: {
        accessToken: params.accessToken,
        accountId: params.accountId,
      },
    });
    try {
      const client = await this.remoteClientPromise;
      if (previous) {
        await previous.client.close();
      }
      this.remoteClientState = {
        authKey,
        client,
      };
      return client;
    } finally {
      this.remoteClientPromise = null;
    }
  }

  private async getToolCache(publicationState: PublicationState): Promise<BridgeToolCache> {
    const snapshotKey =
      publicationState.kind === "snapshot"
        ? `snapshot:${computeSnapshotKey(publicationState.snapshot)}:${hashChatgptAppsConfig(publicationState.config)}`
        : `degraded:${hashChatgptBaseUrl(publicationState.config.chatgptBaseUrl)}:${hashChatgptAppsConfig(publicationState.config)}`;
    if (this.toolCache?.snapshotKey === snapshotKey) {
      return this.toolCache;
    }
    if (this.toolCachePromise) {
      return await this.toolCachePromise;
    }
    this.toolCachePromise =
      publicationState.kind === "snapshot"
        ? this.buildToolCacheFromSnapshot(publicationState.snapshot, publicationState.config)
        : this.buildDegradedToolCache(publicationState.config);
    try {
      this.toolCache = await this.toolCachePromise;
      return this.toolCache;
    } finally {
      this.toolCachePromise = null;
    }
  }

  private async buildToolCacheFromSnapshot(
    snapshot: PersistedConnectorSnapshot,
    config: ReturnType<typeof resolveChatgptAppsConfig>,
  ): Promise<BridgeToolCache> {
    const configuredConnectors = config.connectors;
    const allowedConnectorIds = buildAllowedConnectorIds({
      inventory: snapshot.inventory,
      configuredConnectors,
    });
    const routes = new Map<string, BridgeRoute>();
    const tools: Tool[] = [];

    if (allowedConnectorIds.size === 0) {
      return {
        snapshotKey: computeSnapshotKey(snapshot),
        tools,
        routes,
      };
    }

    const remoteTools =
      snapshot.statuses.length > 0
        ? snapshot.statuses.flatMap((status) =>
            Object.entries(status.tools ?? {}).flatMap(([, tool]) =>
              tool ? [tool as RemoteTool] : [],
            ),
          )
        : await this.listRemoteTools(config.chatgptBaseUrl);
    const remoteToolConnectorMap = buildRemoteToolConnectorMap({
      statuses: snapshot.statuses,
      allowedConnectorIds,
    });

    for (const tool of remoteTools) {
      const connectorId =
        remoteToolConnectorMap.get(tool.name) ??
        resolveConnectorIdForRemoteToolName(tool.name, allowedConnectorIds);
      if (!connectorId) {
        continue;
      }

      const route = {
        connectorId,
        remoteName: tool.name,
        remoteMeta: isRecord(tool._meta) ? { ...tool._meta } : undefined,
      };
      const rewritten = withRoutingMetadata(tool, route);
      tools.push(rewritten);
      routes.set(rewritten.name, route);
    }

    return {
      snapshotKey: `snapshot:${computeSnapshotKey(snapshot)}:${hashChatgptAppsConfig(config)}`,
      tools,
      routes,
    };
  }

  private async buildDegradedToolCache(
    config: EnsureFreshSnapshotResult["config"],
  ): Promise<BridgeToolCache> {
    const routes = new Map<string, BridgeRoute>();
    const tools: Tool[] = [];
    const { wildcardEnabled, enabledConnectorIds, disabledConnectorIds } =
      buildConnectorConfigState(config.connectors);
    if (!wildcardEnabled && enabledConnectorIds.size === 0) {
      return {
        snapshotKey: `degraded:${hashChatgptBaseUrl(config.chatgptBaseUrl)}:${hashChatgptAppsConfig(config)}`,
        tools,
        routes,
      };
    }

    const remoteTools = await this.listRemoteTools(config.chatgptBaseUrl);
    const prefixCounts = buildRemoteToolPrefixCounts(remoteTools);
    for (const tool of remoteTools) {
      const connectorId = wildcardEnabled
        ? (resolveConnectorIdFromRemoteToolMetadata(tool) ??
          resolveConnectorIdFromRemoteToolNamePrefix(tool.name, prefixCounts))
        : (resolveConnectorIdForRemoteToolName(tool.name, enabledConnectorIds) ??
          resolveConnectorIdFromRemoteToolMetadata(tool));
      if (!connectorId) {
        continue;
      }
      if (disabledConnectorIds.has(connectorId)) {
        continue;
      }
      if (!wildcardEnabled && !enabledConnectorIds.has(connectorId)) {
        continue;
      }

      const route = {
        connectorId,
        remoteName: tool.name,
        remoteMeta: isRecord(tool._meta) ? { ...tool._meta } : undefined,
      };
      const rewritten = withRoutingMetadata(tool, route);
      tools.push(rewritten);
      routes.set(rewritten.name, route);
    }

    return {
      snapshotKey: `degraded:${hashChatgptBaseUrl(config.chatgptBaseUrl)}:${hashChatgptAppsConfig(config)}`,
      tools,
      routes,
    };
  }

  private async listRemoteTools(chatgptBaseUrl: string): Promise<RemoteTool[]> {
    const auth = await this.resolveProjectedAuth({
      config: this.loadOpenClawConfig(),
      agentDir: this.env.OPENCLAW_AGENT_DIR,
    });
    if (auth.status !== "ok") {
      return [];
    }

    const remoteClient = await this.getRemoteClient({
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      chatgptBaseUrl,
    });

    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const response = await remoteClient.listTools(cursor ? { cursor } : undefined);
      tools.push(...response.tools.map((tool) => tool as RemoteTool));
      cursor = response.nextCursor;
    } while (cursor);

    return tools;
  }

  private scheduleBackgroundRefresh(): void {
    if (this.backgroundRefreshPromise) {
      return;
    }

    const hardRefresh = this.consumeHardRefresh();
    this.backgroundRefreshPromise = (async () => {
      const result = await this.ensureFreshSnapshot({
        loadOpenClawConfig: this.loadOpenClawConfig,
        env: this.env,
        workspaceDir: this.workspaceDir,
        hardRefresh,
      });
      if (result.status === "ok") {
        const nextSnapshotKey = `snapshot:${computeSnapshotKey(result.snapshot)}:${hashChatgptAppsConfig(result.config)}`;
        if (this.toolCache && this.toolCache.snapshotKey !== nextSnapshotKey) {
          this.invalidateToolCache();
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.backgroundRefreshPromise = null;
      });
  }
}

export async function runChatgptAppsMcpBridgeStdio(params: {
  loadOpenClawConfig: () => OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  hardRefresh?: boolean;
}): Promise<void> {
  const bridge = new ChatgptAppsMcpBridge(params);
  await bridge.connect(new StdioServerTransport());
}
