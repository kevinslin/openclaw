import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const REMOTE_CLIENT_INFO = {
  name: "openclaw-chatgpt-apps-bridge",
  version: "0.1.0",
} as const;

const RawListToolsResultSchema = z
  .object({
    tools: z.array(z.unknown()),
    nextCursor: z.string().optional(),
  })
  .passthrough();

export type RemoteCodexAppsAuth = {
  accessToken: string;
  accountId: string;
};

export type RemoteCodexAppsClient = {
  listTools(params?: { cursor?: string }): Promise<{
    tools: Tool[];
    nextCursor?: string;
  }>;
  callTool(
    params: Pick<CallToolRequest["params"], "name" | "arguments" | "_meta">,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
};

export type RemoteCodexAppsClientFactory = (params: {
  chatgptBaseUrl: string;
  auth: RemoteCodexAppsAuth;
  fetch?: typeof fetch;
}) => Promise<RemoteCodexAppsClient>;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function appendPath(basePath: string, suffix: string): string {
  const trimmedBase = trimTrailingSlashes(basePath);
  const trimmedSuffix = suffix.replace(/^\/+/, "");
  if (!trimmedBase) {
    return `/${trimmedSuffix}`;
  }
  return `${trimmedBase}/${trimmedSuffix}`;
}

export function deriveChatgptAppsMcpUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";

  const hostname = url.hostname.toLowerCase();
  const pathname = trimTrailingSlashes(url.pathname);

  if (hostname === "chat.openai.com" && (pathname === "" || pathname === "/backend-api")) {
    url.hostname = "chatgpt.com";
    url.pathname = "/backend-api/wham/apps";
    return url.toString();
  }

  if (hostname === "chatgpt.com" && (pathname === "" || pathname === "/backend-api")) {
    url.pathname = "/backend-api/wham/apps";
    return url.toString();
  }

  if (pathname.includes("/api/codex")) {
    url.pathname = appendPath(pathname, "apps");
    return url.toString();
  }

  url.pathname = appendPath(pathname, "api/codex/apps");
  return url.toString();
}

export const createRemoteCodexAppsClient: RemoteCodexAppsClientFactory = async (params) => {
  const transport = new StreamableHTTPClientTransport(
    new URL(deriveChatgptAppsMcpUrl(params.chatgptBaseUrl)),
    {
      fetch: params.fetch,
      requestInit: {
        headers: {
          Authorization: `Bearer ${params.auth.accessToken}`,
          "ChatGPT-Account-ID": params.auth.accountId,
        },
      },
    },
  );
  const client = new Client(REMOTE_CLIENT_INFO);
  await client.connect(transport);

  return {
    listTools: async (listParams = {}) => {
      const result = await client.request(
        {
          method: "tools/list",
          params: listParams.cursor ? { cursor: listParams.cursor } : {},
        },
        RawListToolsResultSchema,
      );
      return {
        tools: result.tools as Tool[],
        nextCursor: result.nextCursor ?? undefined,
      };
    },
    callTool: async (callParams) =>
      (await client.callTool(
        {
          name: callParams.name,
          arguments: callParams.arguments,
          _meta: callParams._meta,
        },
        CallToolResultSchema,
      )) as CallToolResult,
    close: async () => {
      await client.close();
    },
  };
};
