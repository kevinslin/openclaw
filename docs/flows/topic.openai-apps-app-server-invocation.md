# OpenAI Apps App-Server Invocation Flow

Last updated: 2026-03-30

## Purpose

This flow explains the current `openai-apps` runtime after the app-list-only
snapshot migration. It covers both publication and execution:

- `tools/list` publishes one local MCP tool per enabled connector
- `tools/call` resolves that local tool back into one app-server app invocation
- each invocation runs on a fresh app-server thread without any remote MCP tool
  proxying

## Entry points

- `extensions/openai-apps/src/mcp-bridge.ts`
- `extensions/openai-apps/src/app-server-invoker.ts`
- `extensions/openai-apps/src/app-server-session.ts`
- `extensions/openai-apps/src/refresh-snapshot.ts`
- `extensions/openai-apps/src/auth-projector.ts`

## Tool List Flow

1. `ChatgptAppsMcpBridge.listTools()` calls `getPublicationState()`.
2. `getPublicationState()` calls `ensureFreshSnapshot(...)`.
3. `ensureFreshSnapshot(...)` either:
   - reuses a fresh persisted snapshot, or
   - spawns `codex app-server`, logs in, writes bundle-owned app config, reads
     only `app/list`, derives canonical connector records, and persists that
     connector snapshot.
4. `buildToolCacheFromSnapshot(...)` computes the allowed connector ids from:
   - accessible and enabled persisted connector records in `snapshot.connectors`
   - bundle config under `plugins.entries.openai-apps.config.connectors`
5. The bridge publishes exactly one tool named
   `chatgpt_app_<connectorId>` per allowed connector.

Important invariants:

- Publication is rebuilt from persisted connector records only.
- There is no degraded remote-MCP publication path.
- Published tools use a generic input schema with a single required `request`
  string.

ASCII view:

```text
OpenClaw host
    |
    | tools/list
    v
openai-apps MCP bridge
    |
    | ensureFreshSnapshot()
    v
persisted snapshot? ---- no/expired/hard refresh ---> spawn codex app-server
    |                                               |
    | yes                                           | login + write apps config
    v                                               | read app/list
snapshot.connectors[]                               | derive connector records
    |                                               v
    +------------------------------<-------- persist snapshot
    |
    | build connector routes
    v
chatgpt_app_gmail
chatgpt_app_google_calendar
chatgpt_app_linear
...
```

## Tool Call Flow

1. The MCP host calls one published connector tool such as
   `chatgpt_app_gmail`.
2. `ChatgptAppsMcpBridge.callTool(...)` reloads the current snapshot-backed
   route map.
3. The bridge resolves the route from the persisted connector record:
   - `connectorId`
   - `appId`
   - `publishedName`
   - `appName`
   - `appInvocationToken`
4. The bridge calls `invokeViaAppServer(...)`.
5. `invokeViaAppServer(...)`:
   - resolves OpenClaw-owned `openai-codex` auth
   - spawns a short-lived `codex app-server` client
   - logs in and writes bundle-owned app config
   - creates a fresh thread
   - starts a turn with:
     - text input `$<app-slug> <request>`
     - mention input `app://<appId>`
6. The invoker waits for turn completion, reads the thread, extracts the final
   text, and returns `CallToolResult`.

Important invariants:

- Every invocation uses a fresh thread.
- The bundle never registers or subscribes to `item/tool/call`.
- There is no direct remote ChatGPT apps MCP usage in the bundle.

ASCII view:

```text
OpenClaw host
    |
    | tools/call chatgpt_app_gmail { request: "Summarize recent mail" }
    v
openai-apps MCP bridge
    |
    | resolve route from snapshot.connectors[]
    v
invokeViaAppServer()
    |
    | spawn codex app-server
    | login + write apps config
    | start fresh thread
    v
turn/start
  input[0]: "$gmail Summarize recent mail"
  input[1]: mention path="app://asdk_app_gmail"
    |
    v
app-server executes app turn
    |
    v
thread/read final turn
    |
    v
CallToolResult text
```

## Failure Modes

- Auth projection failure: the bridge throws before spawning the child
  app-server.
- Missing or empty `request`: `tools/call` fails before `turn/start`.
- Approval or elicitation request: the invoker fails fast with a descriptive
  error.
- Missing final turn text: the invoker throws
  `App invocation completed without a usable final result`.

## Notes

- `app/list` remains the only external inventory source.
- Connector enablement is mirrored into the sidecar config written into the
  spawned app-server session.
- The published local namespace is `chatgpt_app_<connectorId>`, not
  per-remote-tool naming.
