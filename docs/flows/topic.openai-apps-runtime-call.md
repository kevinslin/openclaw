# OpenAI Apps Runtime Call Flow

Last updated: 2026-03-30

## Purpose

This flow explains how one published `openai-apps` tool call is resolved and
executed after publication has already been derived from the persisted
connector snapshot.

It answers:

- how `tools/call` resolves a published tool name back to one connector record
- how the bridge reconstructs the invocation route from snapshot metadata alone
- how the app-server turn is started without any remote MCP tool proxying

## Entry points

- `extensions/openai-apps/src/mcp-bridge.ts`
- `extensions/openai-apps/src/app-server-invoker.ts`
- `extensions/openai-apps/src/snapshot-cache.ts`

## Runtime Route Reconstruction

1. The MCP host calls a published tool such as `chatgpt_app_gmail`.
2. `ChatgptAppsMcpBridge.callTool(...)` asks `ensureFreshSnapshot(...)` for the
   current publication state.
3. `buildToolCacheFromSnapshot(...)` rebuilds an in-memory route map directly
   from `snapshot.connectors[]`.
4. The selected route contains only the fields needed for invocation:
   - `connectorId`
   - `appId`
   - `publishedName`
   - `appName`
   - `appInvocationToken`
5. No live status lookup is needed to rebuild this route.

## Invocation Flow

1. The bridge resolves the requested tool name to an
   `AppServerInvocationRoute`.
2. The bridge calls `invokeViaAppServer(...)`.
3. The invoker:
   - projects `openai-codex` auth from OpenClaw config
   - spawns a short-lived `codex app-server` client
   - writes bundle-owned `apps` config into that sidecar session
   - starts a fresh thread
4. The turn input contains:
   - text input: `$<appInvocationToken> <request>`
   - mention input: `app://<appId>`
5. The invoker waits for completion, reads the thread, extracts the final text,
   and returns it as the MCP tool result.

ASCII view:

```text
tools/call chatgpt_app_gmail
          |
          v
snapshot.connectors[] -> route lookup
          |
          v
invokeViaAppServer()
          |
          | fresh app-server thread
          | input[0] = "$gmail Summarize my inbox"
          | input[1] = mention path "app://asdk_app_gmail"
          v
final thread text -> CallToolResult
```

## Invariants

- Published-tool routing is fully reconstructible from the persisted connector
  snapshot.
- Every invocation uses a fresh app-server thread.
- The bundle does not proxy remote MCP tools.
- The bundle does not need connector capability metadata to invoke an app.

## Failure Modes

- Unknown published tool name: the bridge throws `Unknown ChatGPT app tool`.
- Missing or empty `request`: the invoker rejects before starting the turn.
- Auth projection failure: the invoker fails before sidecar login.
- Approval or elicitation request that cannot be satisfied: the invoker fails
  with a descriptive error.
- Completed turn without a usable final answer: the invoker throws
  `App invocation completed without a usable final result`.
