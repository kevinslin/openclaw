import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { protocol } from "codex-app-server-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  invokeViaAppServer,
  type AppServerInvocationRoute,
  type AppServerToolInvoker,
} from "./app-server-invoker.js";
import { resolveChatgptAppsProjectedAuth } from "./auth-projector.js";
import { hashChatgptAppsConfig, resolveChatgptAppsConfig } from "./config.js";
import { ensureFreshSnapshot } from "./refresh-snapshot.js";
import { computeSnapshotKey, type PersistedConnectorSnapshot } from "./snapshot-cache.js";
import { resolveChatgptAppsStatePaths } from "./state-paths.js";

type AppInfo = protocol.v2.AppInfo;
type McpServerStatus = protocol.v2.McpServerStatus;

export const MCP_SERVER_NAME = "openai-apps";
const ROUTING_META_KEY = "openclaw/chatgpt-apps";
const CONNECTOR_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    request: {
      type: "string",
      description: "Natural-language instruction to send to this ChatGPT app.",
    },
  },
  required: ["request"],
} satisfies Tool["inputSchema"];

type BridgeRoute = AppServerInvocationRoute;

type BridgeToolCache = {
  snapshotKey: string;
  tools: Tool[];
  routes: Map<string, BridgeRoute>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EXCLUDED_CONNECTOR_IDS = new Set([
  "collab",
  "connector_openai_general_agent",
  "general_agent",
]);

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

function shouldExcludeConnectorId(connectorId: string | null | undefined): boolean {
  if (!connectorId) {
    return false;
  }
  return EXCLUDED_CONNECTOR_IDS.has(normalizeConnectorKey(connectorId));
}

function normalizeAppInvocationToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function deriveAppInvocationToken(app: AppInfo, connectorId: string): string {
  for (const candidate of [app.name, ...app.pluginDisplayNames, connectorId]) {
    const normalized = normalizeAppInvocationToken(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return "app";
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

  const allowed = new Set<string>();
  for (const app of params.inventory) {
    if (!app.isAccessible || !app.isEnabled) {
      continue;
    }
    for (const connectorId of deriveConnectorKeysFromApp(app)) {
      if (shouldExcludeConnectorId(connectorId) || disabledConnectorIds.has(connectorId)) {
        continue;
      }
      if (
        Object.keys(params.configuredConnectors).length === 0 ||
        wildcardEnabled ||
        enabledConnectorIds.has(connectorId)
      ) {
        allowed.add(connectorId);
      }
    }
  }

  return allowed;
}

function buildAppRouteByConnectorId(inventory: AppInfo[]): Map<string, BridgeRoute> {
  const routes = new Map<string, BridgeRoute>();

  for (const app of inventory) {
    if (!app.isAccessible || !app.isEnabled) {
      continue;
    }
    for (const connectorId of deriveConnectorKeysFromApp(app)) {
      if (shouldExcludeConnectorId(connectorId) || routes.has(connectorId)) {
        continue;
      }
      routes.set(connectorId, {
        connectorId,
        publishedName: `chatgpt_app_${connectorId}`,
        appName: app.name || app.pluginDisplayNames[0] || connectorId,
        appInvocationToken: deriveAppInvocationToken(app, connectorId),
      });
    }
  }

  return routes;
}

function buildStatusByConnectorId(statuses: McpServerStatus[]): Map<string, McpServerStatus> {
  const map = new Map<string, McpServerStatus>();
  for (const status of statuses) {
    const connectorId = normalizeConnectorKey(status.name);
    if (!connectorId || shouldExcludeConnectorId(connectorId) || map.has(connectorId)) {
      continue;
    }
    map.set(connectorId, status);
  }
  return map;
}

function buildToolDescription(app: AppInfo, status?: McpServerStatus): string {
  const toolCount = status ? Object.keys(status.tools ?? {}).length : 0;
  const lead =
    app.description?.trim() || `Use ${app.name || status?.name || app.id} through ChatGPT apps.`;
  const capabilitySuffix =
    toolCount > 0
      ? ` The app exposes ${toolCount} server-side capability${toolCount === 1 ? "" : "ies"}.`
      : "";
  return `${lead}${capabilitySuffix} Send a natural-language instruction in the request field.`;
}

function buildPublishedTool(route: BridgeRoute, app: AppInfo, status?: McpServerStatus): Tool {
  return {
    name: route.publishedName,
    description: buildToolDescription(app, status),
    inputSchema: CONNECTOR_TOOL_INPUT_SCHEMA,
    _meta: {
      [ROUTING_META_KEY]: {
        connectorId: route.connectorId,
      },
    },
  };
}

type PublicationState = {
  config: ReturnType<typeof resolveChatgptAppsConfig>;
  snapshot: PersistedConnectorSnapshot;
};

export class ChatgptAppsMcpBridge {
  private readonly server: Server;
  private readonly loadOpenClawConfig: () => OpenClawConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly workspaceDir?: string;
  private readonly ensureFreshSnapshot;
  private readonly resolveProjectedAuth;
  private readonly appServerInvoker: AppServerToolInvoker;
  private hardRefreshRequested: boolean;
  private toolCache: BridgeToolCache | null = null;
  private toolCachePromise: Promise<BridgeToolCache> | null = null;

  constructor(params: {
    loadOpenClawConfig: () => OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    hardRefresh?: boolean;
    ensureFreshSnapshot?: typeof ensureFreshSnapshot;
    resolveProjectedAuth?: typeof resolveChatgptAppsProjectedAuth;
    appServerInvoker?: AppServerToolInvoker;
  }) {
    this.loadOpenClawConfig = params.loadOpenClawConfig;
    this.env = params.env ?? process.env;
    this.workspaceDir = params.workspaceDir;
    this.hardRefreshRequested = params.hardRefresh ?? false;
    this.ensureFreshSnapshot = params.ensureFreshSnapshot ?? ensureFreshSnapshot;
    this.resolveProjectedAuth = params.resolveProjectedAuth ?? resolveChatgptAppsProjectedAuth;
    this.appServerInvoker = params.appServerInvoker ?? invokeViaAppServer;

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
        await this.callTool(request.params.name, request.params.arguments),
    );
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    this.toolCache = null;
    this.toolCachePromise = null;
    await this.server.close();
  }

  async listTools(): Promise<Tool[]> {
    const publicationState = await this.getPublicationState();
    const cache = await this.getToolCache(publicationState);
    return cache.tools;
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const publicationState = await this.getPublicationState();
    const cache = await this.getToolCache(publicationState);
    const route = cache.routes.get(name);
    if (!route) {
      throw new Error(`Unknown ChatGPT app tool: ${name}`);
    }

    return await this.appServerInvoker({
      config: publicationState.config,
      route,
      args,
      statePaths: resolveChatgptAppsStatePaths(this.env),
      workspaceDir: this.workspaceDir,
      env: this.env,
      resolveProjectedAuth: async () =>
        await this.resolveProjectedAuth({
          config: this.loadOpenClawConfig(),
          agentDir: this.env.OPENCLAW_AGENT_DIR,
        }),
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
    const refreshResult = await this.ensureFreshSnapshot({
      loadOpenClawConfig: this.loadOpenClawConfig,
      env: this.env,
      workspaceDir: this.workspaceDir,
      hardRefresh: this.consumeHardRefresh(),
    });
    if (refreshResult.status !== "ok") {
      throw new Error(refreshResult.message);
    }

    return {
      config: refreshResult.config,
      snapshot: refreshResult.snapshot,
    };
  }

  private async getToolCache(publicationState: PublicationState): Promise<BridgeToolCache> {
    const snapshotKey = `snapshot:${computeSnapshotKey(publicationState.snapshot)}:${hashChatgptAppsConfig(publicationState.config)}`;
    if (this.toolCache?.snapshotKey === snapshotKey) {
      return this.toolCache;
    }
    if (this.toolCachePromise) {
      return await this.toolCachePromise;
    }

    this.toolCachePromise = this.buildToolCacheFromSnapshot(
      publicationState.snapshot,
      publicationState.config,
    );
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
    const allowedConnectorIds = buildAllowedConnectorIds({
      inventory: snapshot.inventory,
      configuredConnectors: config.connectors,
    });
    const routes = new Map<string, BridgeRoute>();
    const tools: Tool[] = [];

    if (allowedConnectorIds.size === 0) {
      return {
        snapshotKey: `snapshot:${computeSnapshotKey(snapshot)}:${hashChatgptAppsConfig(config)}`,
        tools,
        routes,
      };
    }

    const appRoutes = buildAppRouteByConnectorId(snapshot.inventory);
    const statusByConnectorId = buildStatusByConnectorId(snapshot.statuses);

    for (const connectorId of [...allowedConnectorIds].sort()) {
      const route = appRoutes.get(connectorId);
      if (!route) {
        throw new Error(`Missing app inventory entry for connector: ${connectorId}`);
      }
      const app = snapshot.inventory.find((entry) =>
        deriveConnectorKeysFromApp(entry).includes(connectorId),
      );
      if (!app) {
        throw new Error(`Missing app inventory metadata for connector: ${connectorId}`);
      }

      const status = statusByConnectorId.get(connectorId);
      const tool = buildPublishedTool(route, app, status);
      tools.push(tool);
      routes.set(tool.name, route);
    }

    return {
      snapshotKey: `snapshot:${computeSnapshotKey(snapshot)}:${hashChatgptAppsConfig(config)}`,
      tools,
      routes,
    };
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
