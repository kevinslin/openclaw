# OpenAI Apps Startup And Snapshot Cache Flow

Last updated: 2026-03-30

## Purpose

This flow explains how the `openai-apps` MCP bundle boots, decides whether to
reuse or refresh its persisted connector snapshot, and turns that snapshot into
published connector tools.

It exists to debug three recurring questions:

- why `tools/list` returns no tools
- why a connector snapshot did or did not refresh
- whether the current response came from cache or a fresh app-server refresh

## Entry points

- `extensions/openai-apps/src/server.ts`
- `extensions/openai-apps/src/mcp-bridge.ts`
- `extensions/openai-apps/src/refresh-snapshot.ts`
- `extensions/openai-apps/src/app-server-session.ts`
- `extensions/openai-apps/src/snapshot-cache.ts`

## Phase 1: Boot

1. OpenClaw launches the `openai-apps` stdio MCP process.
2. `server.ts` loads OpenClaw config once and resolves the one-shot
   `--hard-refresh` flag.
3. `runChatgptAppsMcpBridgeStdio(...)` constructs `ChatgptAppsMcpBridge` and
   registers `tools/list` and `tools/call` handlers.
4. No snapshot refresh happens at boot. The first request drives cache lookup.

## Phase 2: Decide Cache Hit Versus Refresh

1. `tools/list` calls `ChatgptAppsMcpBridge.listTools()`.
2. The bridge calls `ensureFreshSnapshot(...)`.
3. `ensureFreshSnapshot(...)` resolves:
   - normalized `openai-apps` config
   - projected `openai-codex` auth
   - bundle-owned state paths
4. The bridge reads `connectors.snapshot.json`.
5. A cached snapshot is reused only when all of these still match:
   - snapshot version
   - TTL
   - projected account identity
   - config hash
   - base-url hash
   - no pending hard refresh
6. On a cache hit, the bridge writes `refresh-debug.json` with `source: "cache"`
   and returns the persisted snapshot.

## Phase 3: Refresh Snapshot

1. On a cache miss, `ensureFreshSnapshot(...)` calls
   `captureAppServerSnapshot(...)`.
2. That helper:
   - spawns `codex app-server`
   - initializes the session
   - logs in with projected ChatGPT auth
   - writes bundle-owned `apps` config into the sidecar session
   - reads paginated `app/list`
   - reads account and auth status for debug metadata
3. `refresh-snapshot.ts` derives canonical connector records from the returned
   apps and writes a new v2 snapshot atomically.
4. The refresh debug file is updated with `source: "refresh"`.

ASCII view:

```text
tools/list
   |
   v
ensureFreshSnapshot()
   |
   +--> fresh v2 snapshot exists ---> use snapshot.connectors[]
   |
   +--> stale/missing ----------> spawn codex app-server
                                   |
                                   | login + write apps config
                                   | read app/list
                                   v
                             derive connector records
                                   |
                                   v
                          write connectors.snapshot.json
```

## Phase 4: Build Published Tool Cache

1. `mcp-bridge.ts` hashes the persisted snapshot plus normalized bundle config.
2. If the in-memory tool cache matches that key, it is reused.
3. Otherwise the bridge rebuilds:
   - allowed connector ids from config plus persisted connector accessibility
   - one route per canonical connector record
   - one published MCP tool per allowed connector
4. Published tools use the namespace `chatgpt_app_<connectorId>`.

## Persisted Snapshot Contract

The v2 snapshot stores connector records only:

```json
{
  "version": 2,
  "fetchedAt": "2026-03-30T18:01:00.000Z",
  "projectedAt": "2026-03-30T18:01:00.000Z",
  "accountId": "acct_123",
  "authIdentityKey": "user@example.com",
  "configHash": "abc123",
  "baseUrlHash": "def456",
  "connectors": [
    {
      "connectorId": "gmail",
      "appId": "asdk_app_gmail",
      "appName": "Gmail",
      "publishedName": "chatgpt_app_gmail",
      "appInvocationToken": "gmail",
      "description": "Search and summarize Gmail threads.",
      "pluginDisplayNames": ["Gmail"],
      "isAccessible": true,
      "isEnabled": true
    }
  ]
}
```

## Failure Modes

- Disabled plugin config: snapshot lookup returns a disabled error.
- Auth projection failure: refresh debug is written with failure details.
- Refresh timeout or app-server failure: publication fails instead of degrading.
- Malformed persisted connector record: publication fails fast.
- Duplicate canonical connector ids during derivation: refresh fails fast.

## Notes

- `app/list` is the only external inventory source used during refresh.
- Publication is rebuilt entirely from persisted connector records.
- Accessibility and enablement are persisted for debugging, but publication
  still re-applies those gates at read time.
