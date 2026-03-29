import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CHATGPT_APPS_BASE_URL } from "./config.js";

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
  auth: RemoteCodexAppsAuth;
  fetch?: typeof fetch;
}) => Promise<RemoteCodexAppsClient>;

export function deriveChatgptAppsMcpUrl(): string {
  const url = new URL(CHATGPT_APPS_BASE_URL);
  url.search = "";
  url.hash = "";
  url.pathname = "/backend-api/wham/apps";
  return url.toString();
}

export const createRemoteCodexAppsClient: RemoteCodexAppsClientFactory = async (params) => {
  const transport = new StreamableHTTPClientTransport(new URL(deriveChatgptAppsMcpUrl()), {
    fetch: params.fetch,
    requestInit: {
      headers: {
        Authorization: `Bearer ${params.auth.accessToken}`,
        "ChatGPT-Account-ID": params.auth.accountId,
      },
    },
  });
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
