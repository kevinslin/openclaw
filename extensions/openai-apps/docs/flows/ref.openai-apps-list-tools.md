# OpenAI Apps listTools Flow

Last updated: 2026-03-30

## Purpose

This flow documents how the `openai-apps` bundle boots, refreshes or reuses its connector snapshot, and publishes MCP tools for `listTools`. It answers two debugging questions: where the published tool list comes from, and which state changes force the bundle to rebuild that list.

## Entry points

- `extensions/openai-apps/src/server.ts`: runtime bootstrap that resolves environment/config and starts the stdio MCP bridge
- `extensions/openai-apps/src/mcp-bridge.ts`: MCP `listTools` handler plus per-process tool-cache management
- `extensions/openai-apps/src/refresh-snapshot.ts`: snapshot refresh, auth projection, refresh, and persistence
- `extensions/openai-apps/src/app-server-session.ts`: app-server session used only when snapshot refresh is required

## Call path

### Phase 1: Bootstrap the MCP bridge

Trigger / entry condition:

- The `openai-apps` bundle process starts, or an already-running bridge receives an MCP `tools/list` request.

Entrypoints:

- `extensions/openai-apps/src/server.ts:main`
- `extensions/openai-apps/src/mcp-bridge.ts:runChatgptAppsMcpBridgeStdio`
- `extensions/openai-apps/src/mcp-bridge.ts:ChatgptAppsMcpBridge.constructor`

Ordered call path:

1. Resolve runtime env, load OpenClaw config, and start the stdio bridge.
   ```ts
   // Source: extensions/openai-apps/src/server.ts#L42-L51
   runtimeEnv := await resolveOpenaiAppsRuntimeEnv(process.env)
   config := await loadRawConfig(runtimeEnv)
   await runChatgptAppsMcpBridgeStdio({
     loadOpenClawConfig: () => config,
     env: runtimeEnv,
   })
   ```
2. Register the MCP request handlers and route `tools/list` into `listTools()`.
   ```ts
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L193-L220
   this.server := new Server({ name: MCP_SERVER_NAME, version: "0.1.0" }, { capabilities.tools.listChanged := true })
   this.server.setRequestHandler(ListToolsRequestSchema, async request => {
     if request.params?.cursor
       return { tools: [] }
     return { tools: await this.listTools() }
   })
   this.server.setRequestHandler(CallToolRequestSchema, async request =>
     await this.callTool(request.params.name, request.params.arguments)
   )
   ```
3. Re-enter `listTools` for each non-paginated request and hand off to publication-state resolution.
   ```ts
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L233-L237
   publicationState := await this.getPublicationState()
   cache := await this.getToolCache(publicationState)
   return cache.tools
   ```

State transitions / outputs:

- Input: runtime env and raw OpenClaw config
- Output: connected MCP bridge with a live `ListToolsRequestSchema` handler

Branch points:

- `request.params?.cursor` returns an empty page instead of rebuilding the tool list.

External boundaries:

- MCP stdio transport via `StdioServerTransport`

### Phase 2: Resolve publication state and snapshot reuse

Trigger / entry condition:

- `listTools()` needs the current connector publication state.

Entrypoints:

- `extensions/openai-apps/src/mcp-bridge.ts:getPublicationState`
- `extensions/openai-apps/src/refresh-snapshot.ts:ensureFreshSnapshot`

Ordered call path:

1. Resolve plugin config and projected auth before any publication decision.
   ```ts
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L268-L283
   // Source: extensions/openai-apps/src/refresh-snapshot.ts#L59-L107
   openclawConfig := params.loadOpenClawConfig()
   config := resolveChatgptAppsConfig(openclawConfig.plugins?.entries?.["openai-apps"]?.config ?? {})
   statePaths := params.statePaths ?? resolveChatgptAppsStatePaths(env)
   if !config.enabled
     return { status: "error", reason: "disabled", ... }
   auth := await resolveProjectedAuth({ config: openclawConfig, agentDir: env.OPENCLAW_AGENT_DIR })
   if auth.status !== "ok"
     await writeRefreshDebug({ statePaths, debug: { status: "failure", message: auth.message } })
     return { status: "error", reason: "auth", ... }
   ```
2. Reuse a persisted snapshot when its identity and TTL still match.
   ```ts
   // Source: extensions/openai-apps/src/refresh-snapshot.ts#L109-L143
   // Source: extensions/openai-apps/src/snapshot-cache.ts#L112-L133
   currentSnapshot := await readPersistedSnapshot(statePaths.snapshotPath)
   reuseInputs := {
     accountId: auth.accountId,
     authIdentityKey: buildAuthIdentityKey(auth.identity),
   }
   if currentSnapshot && isSnapshotFresh({ snapshot: currentSnapshot, inputs: reuseInputs, now: now() })
     await writeRefreshDebug({ statePaths, debug: { status: "success", source: "cache", accountId: auth.accountId } })
     return { status: "ok", source: "cache", snapshot: currentSnapshot, config, ... }
   ```
3. Refresh through the app server, derive connector records, and persist the new snapshot on cache miss.
   ```ts
   // Source: extensions/openai-apps/src/refresh-snapshot.ts#L145-L230
   // Source: extensions/openai-apps/src/app-server-session.ts#L118-L176
   // Source: extensions/openai-apps/src/app-server-session.ts#L195-L224
   capture := await Promise.race([
     captureSnapshot({
       config,
       statePaths,
       workspaceDir: params.workspaceDir,
       env,
       resolveProjectedAuth: async () => await resolveProjectedAuth({ config: openclawConfig, agentDir: env.OPENCLAW_AGENT_DIR }),
       now,
     }),
     timeout("Timed out refreshing ChatGPT apps snapshot"),
   ])
   withLoggedInAppServerSession(params, async ({ client }) => {
     await client.initializeSession()
     unsubscribe := client.handleChatgptAuthTokensRefresh(async () => refreshedTokens)
     await client.loginAccount(toLoginParams(auth))
     await writeDerivedAppsConfig({
       config: params.config,
       writeConfigValue: writeParams => client.writeConfigValue(writeParams),
       appsConfigWriteGate: params.appsConfigWriteGate,
     })
     do
       response := await client.listApps({ cursor: appCursor, forceRefetch: true })
       apps.push(...response.data)
       appCursor := response.nextCursor
     while appCursor
     [accountResponse, authStatus] := await Promise.all([
       client.readAccount({ refreshToken: false }),
       client.getAuthStatus({ includeToken: false, refreshToken: false }),
     ])
   })
   nextSnapshot := {
     version: SNAPSHOT_VERSION,
     fetchedAt: new Date(now()).toISOString(),
     projectedAt: capture.projectedAt,
     accountId: auth.accountId,
     authIdentityKey: buildAuthIdentityKey(auth.identity),
     connectors: deriveConnectorRecordsFromApps(capture.apps),
   }
   await writePersistedSnapshot({ statePaths, snapshot: nextSnapshot })
   await writeRefreshDebug({ statePaths, debug: { status: "success", source: "refresh", accountId: auth.accountId } })
   return { status: "ok", source: "refresh", snapshot: nextSnapshot, config, ... }
   ```

State transitions / outputs:

- Input: resolved plugin config, agent-backed projected auth, on-disk snapshot state
- Output: `{ config, snapshot }` publication state or a thrown error from `getPublicationState()`

Branch points:

- `config.enabled === false` blocks publication immediately.
- `auth.status !== "ok"` blocks publication and records a failed refresh-debug state.
- `isSnapshotFresh(...) === true` skips the app-server refresh entirely.
- Refresh timeouts and app-server errors are converted into `status: "error", reason: "refresh"` and then thrown by `getPublicationState()`.

External boundaries:

- OpenAI Codex OAuth refresh through `refreshOpenAICodexToken(...)`
- App-server RPCs: `initializeSession`, `loginAccount`, `writeConfigValue` (first use per gateway session / config hash), `listApps`, `readAccount`, `getAuthStatus`
- Snapshot and debug files under the bundle runtime state directory

### Phase 3: Build the published tool cache

Trigger / entry condition:

- `listTools()` has a valid publication state and needs the process-local published tool list.

Entrypoints:

- `extensions/openai-apps/src/mcp-bridge.ts:getToolCache`
- `extensions/openai-apps/src/mcp-bridge.ts:buildToolCacheFromSnapshot`

Ordered call path:

1. Compute a cache key from the persisted snapshot and resolved plugin config.
   ```ts
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L285-L304
   snapshotKey := `snapshot:${computeSnapshotKey(publicationState.snapshot)}:${hashChatgptAppsConfig(publicationState.config)}`
   if this.toolCache?.snapshotKey === snapshotKey
     return this.toolCache
   if this.toolCachePromise
     return await this.toolCachePromise
   this.toolCachePromise := this.buildToolCacheFromSnapshot(publicationState.snapshot, publicationState.config)
   this.toolCache := await this.toolCachePromise
   return this.toolCache
   ```
2. Filter the refreshed snapshot down to allowed connector ids.
   ```ts
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L50-L116
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L306-L323
   allowedConnectorIds := buildAllowedConnectorIds({
     connectors: snapshot.connectors,
     configuredConnectors: config.connectors,
   })
   if allowedConnectorIds.size === 0
     return { snapshotKey, tools: [], routes: new Map() }
   ```
3. Validate connector records, publish one MCP tool per allowed connector, and map tool name to route metadata.

   ```ts
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L118-L157
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L325-L356
   appRoutes := buildAppRouteByConnectorId(snapshot.connectors)
   connectorById := new Map
   for connector of snapshot.connectors
     validatedConnector := assertValidPersistedConnectorRecord(connector)
     if connectorById.has(validatedConnector.connectorId)
       throw Error(`Duplicate connector snapshot record for connector: ${validatedConnector.connectorId}`)
     connectorById.set(validatedConnector.connectorId, validatedConnector)

   for connectorId of [...allowedConnectorIds].sort()
     route := appRoutes.get(connectorId)
     connector := connectorById.get(connectorId)
     if !route
       throw Error(`Missing connector snapshot record for connector: ${connectorId}`)
     if !connector
       throw Error(`Missing connector snapshot metadata for connector: ${connectorId}`)
     tool := buildPublishedTool(route, connector)
     tools.push(tool)
     routes.set(tool.name, route)

   return { snapshotKey, tools, routes }
   ```

State transitions / outputs:

- Input: stable `publicationState.snapshot` plus stable `publicationState.config`
- Output: process-local `BridgeToolCache` containing `tools[]` and `routes: Map<toolName, route>`

Branch points:

- Empty `allowedConnectorIds` yields an empty published tool list.
- Duplicate, malformed, missing, disabled, or excluded connector records abort publication.
- `toolCachePromise` coalesces concurrent cache rebuilds into one in-flight promise.

External boundaries:

- None identified beyond already-loaded in-memory publication state

## State

### Core state / ordering risks

- `config`: resolved from `openclawConfig.plugins.entries["openai-apps"].config` in `ensureFreshSnapshot` before any publication decision, so cache reuse and connector allowlisting see the same resolved config.
- `auth`: projected in `ensureFreshSnapshot` before `readPersistedSnapshot(...)` evaluation, so `accountId` and `authIdentityKey` are initialized before the cached snapshot is accepted or rejected.
- `snapshot`: loaded from `statePaths.snapshotPath`, then either reused or replaced before `getToolCache(...)` consumes it; `listTools()` never builds tools from a half-refreshed snapshot.
- `toolCache`: keyed by the current snapshot plus the resolved config in `getToolCache(...)`, so route publication is frozen per bridge instance until either input changes.

### Runtime controls (or `None identified`)

| Name                                                               | Kind   | Where Read                                                                                                   | Effect on Flow                                                                                 |
| ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `plugins.entries["openai-apps"].config.enabled`                    | config | `extensions/openai-apps/src/refresh-snapshot.ts#L61-L76`                                                     | Disables publication before auth, cache, or refresh work runs.                                 |
| `plugins.entries["openai-apps"].config.connectors`                 | config | `extensions/openai-apps/src/config.ts#L73-L85`, `extensions/openai-apps/src/mcp-bridge.ts#L50-L116`          | Controls wildcard enablement, explicit disables, and which connector records become MCP tools. |
| `plugins.entries["openai-apps"].config.appServer.command/args`     | config | `extensions/openai-apps/src/config.ts#L77-L84`, `extensions/openai-apps/src/app-server-session.ts#L132-L147` | Chooses which app-server binary/session is used for snapshot refresh.                          |
| `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_AGENT_DIR` | env    | `extensions/openai-apps/src/runtime-env.ts#L152-L191`, `extensions/openai-apps/src/state-paths.ts#L14-L42`   | Changes where config, auth store, snapshot, and refresh-debug files are resolved.              |
| `OPENCLAW_OPENAI_APPS_DEBUG=1`                                     | env    | `extensions/openai-apps/src/server.ts#L8-L13`                                                                | Emits bundle bootstrap debug logs to stderr.                                                   |

### Notable gates

- `auth.status === "ok"`: gates both snapshot reuse and snapshot refresh because account and identity are required for publication decisions (`extensions/openai-apps/src/refresh-snapshot.ts#L78-L107`).
- `isSnapshotFresh(...)`: decides whether `listTools` stays local or opens a full app-server session (`extensions/openai-apps/src/refresh-snapshot.ts#L117-L143`).
- `shouldExcludeConnectorId(...)`: blocks internal collab/general-agent style connector ids from publication even under wildcard enablement (`extensions/openai-apps/src/mcp-bridge.ts#L100-L113`, `extensions/openai-apps/src/connector-record.ts#L17-L60`).
- `assertValidPersistedConnectorRecord(...)`: prevents malformed snapshot records from becoming published tools (`extensions/openai-apps/src/connector-record.ts#L217-L243`).

## Sequence diagram

```
+------------------------+
| bundle process starts  |
+------------------------+
           |
           v
+------------------------+
| resolve runtime env    |
| load config            |
+------------------------+
           |
           v
+------------------------+
| MCP tools/list request |
+------------------------+
           |
           v
+-----------------------------+
| ensureFreshSnapshot         |
| config + auth resolved      |
+-----------------------------+
    | fresh cache        | refresh needed
    v                    v
+----------------+   +----------------------+
| reuse snapshot |   | app-server session   |
| + write debug  |   | listApps + status    |
+----------------+   +----------------------+
    |                    |
    +---------+----------+
              |
              v
+-----------------------------+
| getToolCache(snapshot, cfg) |
| filter + validate + publish |
+-----------------------------+
              |
              v
+-----------------------------+
| return published tools[]    |
+-----------------------------+
```

## Observability

Metrics:

- None identified in `extensions/openai-apps`; this flow exposes debug files/logs but no dedicated counters or timers.

Logs:

- `extensions/openai-apps/src/server.ts#L8-L13` writes bootstrap debug lines to stderr when `OPENCLAW_OPENAI_APPS_DEBUG=1`.
- `extensions/openai-apps/src/refresh-snapshot.ts#L91-L98`, `extensions/openai-apps/src/refresh-snapshot.ts#L126-L134`, `extensions/openai-apps/src/refresh-snapshot.ts#L195-L203`, `extensions/openai-apps/src/refresh-snapshot.ts#L213-L220` write `refresh-debug.json` with the last cache/refresh outcome.

## Related docs

- `extensions/openai-apps/docs/flows/ref.openai-apps-call-tool.md`

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-30: Created the `listTools` flow doc from `extensions/openai-apps` code only (019d3ffc-456e-7500-84dc-309b365ada15 - 966651ecb7)
- 2026-03-30: Renamed the flow doc to `ref.openai-apps-list-tools.md` and updated publication-state wording. (019d4105-802e-7bd0-be7e-850070d63c37 - d78a1f3059)
