import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ElicitRequestFormParams,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { protocol } from "codex-app-server-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createAppServerAppsConfigWriteGate,
  type AppServerAppsConfigWriteGate,
} from "./app-server-apps-config.js";
import {
  invokeViaAppServer,
  type AppServerInvocationRoute,
  type AppServerToolInvoker,
} from "./app-server-invoker.js";
import { resolveChatgptAppsProjectedAuth } from "./auth-projector.js";
import { hashChatgptAppsConfig, resolveChatgptAppsConfig } from "./config.js";
import {
  assertValidPersistedConnectorRecord,
  normalizeConnectorKey,
  shouldExcludeConnectorId,
  type PersistedConnectorRecord,
} from "./connector-record.js";
import { ensureFreshSnapshot } from "./refresh-snapshot.js";
import { computeSnapshotKey, type PersistedConnectorSnapshot } from "./snapshot-cache.js";
import { resolveChatgptAppsStatePaths } from "./state-paths.js";

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
type McpServerElicitationRequestParams = protocol.v2.McpServerElicitationRequestParams;

type BridgeToolCache = {
  snapshotKey: string;
  tools: Tool[];
  routes: Map<string, BridgeRoute>;
};

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
  connectors: PersistedConnectorRecord[];
  configuredConnectors: Record<string, { enabled: boolean }>;
}): Set<string> {
  const { wildcardEnabled, enabledConnectorIds, disabledConnectorIds } = buildConnectorConfigState(
    params.configuredConnectors,
  );

  const allowed = new Set<string>();
  for (const connector of params.connectors) {
    assertValidPersistedConnectorRecord(connector);
    if (!connector.isAccessible || !connector.isEnabled) {
      continue;
    }
    if (
      shouldExcludeConnectorId(connector.connectorId) ||
      disabledConnectorIds.has(connector.connectorId)
    ) {
      continue;
    }
    if (
      Object.keys(params.configuredConnectors).length === 0 ||
      wildcardEnabled ||
      enabledConnectorIds.has(connector.connectorId)
    ) {
      allowed.add(connector.connectorId);
    }
  }

  return allowed;
}

function buildAppRouteByConnectorId(
  connectors: PersistedConnectorRecord[],
): Map<string, BridgeRoute> {
  const routes = new Map<string, BridgeRoute>();

  for (const connector of connectors) {
    assertValidPersistedConnectorRecord(connector);
    if (routes.has(connector.connectorId)) {
      throw new Error(
        `Duplicate connector snapshot record for connector: ${connector.connectorId}`,
      );
    }
    routes.set(connector.connectorId, {
      connectorId: connector.connectorId,
      appId: connector.appId,
      publishedName: connector.publishedName,
      appName: connector.appName,
      appInvocationToken: connector.appInvocationToken,
    });
  }

  return routes;
}

function buildToolDescription(connector: PersistedConnectorRecord): string {
  return `${connector.description} Send a natural-language instruction in the request field.`;
}

function buildPublishedTool(route: BridgeRoute, connector: PersistedConnectorRecord): Tool {
  return {
    name: route.publishedName,
    description: buildToolDescription(connector),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatJsonForPrompt(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify(String(value));
  }
}

function resolveDisplayedElicitationPayload(params: McpServerElicitationRequestParams): unknown {
  if (isRecord(params._meta) && isRecord(params._meta.tool_params)) {
    return params._meta.tool_params;
  }
  if (params._meta !== null) {
    return params._meta;
  }
  if (params.mode === "url") {
    return {
      url: params.url,
      elicitationId: params.elicitationId,
    };
  }
  return {
    requestedSchema: params.requestedSchema,
  };
}

function buildDestructiveActionApprovalPrompt(
  params: McpServerElicitationRequestParams,
): ElicitRequestFormParams {
  const meta = isRecord(params._meta) ? params._meta : null;
  const connectorName =
    typeof meta?.connector_name === "string" ? meta.connector_name : params.serverName;
  const toolTitle = typeof meta?.tool_title === "string" ? meta.tool_title : "destructive action";
  const payload = formatJsonForPrompt(resolveDisplayedElicitationPayload(params));

  return {
    message: [
      `The ${connectorName} app requested approval for ${toolTitle}.`,
      typeof params.message === "string" && params.message.trim().length > 0 ? params.message : "",
      "App payload:",
      payload,
      "Choose accept to continue or decline to reject the action.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    requestedSchema: {
      type: "object",
      properties: {},
    },
  };
}

export class ChatgptAppsMcpBridge {
  private readonly server: Server;
  private readonly loadOpenClawConfig: () => OpenClawConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly workspaceDir?: string;
  private readonly ensureFreshSnapshot;
  private readonly resolveProjectedAuth;
  private readonly appServerInvoker: AppServerToolInvoker;
  private readonly appsConfigWriteGate: AppServerAppsConfigWriteGate;
  private toolCache: BridgeToolCache | null = null;
  private toolCachePromise: Promise<BridgeToolCache> | null = null;

  constructor(params: {
    loadOpenClawConfig: () => OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    ensureFreshSnapshot?: typeof ensureFreshSnapshot;
    resolveProjectedAuth?: typeof resolveChatgptAppsProjectedAuth;
    appServerInvoker?: AppServerToolInvoker;
  }) {
    this.loadOpenClawConfig = params.loadOpenClawConfig;
    this.env = params.env ?? process.env;
    this.workspaceDir = params.workspaceDir;
    this.ensureFreshSnapshot = params.ensureFreshSnapshot ?? ensureFreshSnapshot;
    this.resolveProjectedAuth = params.resolveProjectedAuth ?? resolveChatgptAppsProjectedAuth;
    this.appServerInvoker = params.appServerInvoker ?? invokeViaAppServer;
    this.appsConfigWriteGate = createAppServerAppsConfigWriteGate();

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
      appsConfigWriteGate: this.appsConfigWriteGate,
      handleMcpServerElicitation: async (elicitation) =>
        await this.handleMcpServerElicitation(elicitation),
      resolveProjectedAuth: async () =>
        await this.resolveProjectedAuth({
          config: this.loadOpenClawConfig(),
          agentDir: this.env.OPENCLAW_AGENT_DIR,
        }),
    });
  }

  private async getPublicationState(): Promise<PublicationState> {
    const refreshResult = await this.ensureFreshSnapshot({
      loadOpenClawConfig: this.loadOpenClawConfig,
      env: this.env,
      workspaceDir: this.workspaceDir,
      appsConfigWriteGate: this.appsConfigWriteGate,
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
      connectors: snapshot.connectors,
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

    const appRoutes = buildAppRouteByConnectorId(snapshot.connectors);
    const connectorById = new Map<string, PersistedConnectorRecord>();
    for (const connector of snapshot.connectors) {
      const validatedConnector = assertValidPersistedConnectorRecord(connector);
      if (connectorById.has(validatedConnector.connectorId)) {
        throw new Error(
          `Duplicate connector snapshot record for connector: ${validatedConnector.connectorId}`,
        );
      }
      connectorById.set(validatedConnector.connectorId, validatedConnector);
    }

    for (const connectorId of [...allowedConnectorIds].sort()) {
      const route = appRoutes.get(connectorId);
      if (!route) {
        throw new Error(`Missing connector snapshot record for connector: ${connectorId}`);
      }
      const connector = connectorById.get(connectorId);
      if (!connector) {
        throw new Error(`Missing connector snapshot metadata for connector: ${connectorId}`);
      }
      const tool = buildPublishedTool(route, connector);
      tools.push(tool);
      routes.set(tool.name, route);
    }

    return {
      snapshotKey: `snapshot:${computeSnapshotKey(snapshot)}:${hashChatgptAppsConfig(config)}`,
      tools,
      routes,
    };
  }

  private async handleMcpServerElicitation(elicitation: McpServerElicitationRequestParams) {
    const result = await this.server.elicitInput(buildDestructiveActionApprovalPrompt(elicitation));
    if (result.action !== "accept") {
      return {
        action: "decline",
        content: null,
        _meta: null,
      } as const;
    }

    return {
      action: "accept",
      content: {},
      _meta: null,
    } as const;
  }
}

export async function runChatgptAppsMcpBridgeStdio(params: {
  loadOpenClawConfig: () => OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): Promise<void> {
  const bridge = new ChatgptAppsMcpBridge(params);
  await bridge.connect(new StdioServerTransport());
}
