# OpenAI Apps callTool Flow

Last updated: 2026-03-30

## Purpose

This flow documents how a published ChatGPT app tool is invoked after MCP `callTool` reaches the bundle. It answers where route metadata is resolved, how the shared bundle-owned app-server home is prepared for each fresh invocation thread, and which guards can fail the invocation before a final text result is returned.

## Entry points

- `extensions/openai-apps/src/mcp-bridge.ts`: MCP `callTool` handler plus route lookup from the publication cache
- `extensions/openai-apps/src/refresh-snapshot.ts`: publication-state refresh shared with `listTools`
- `extensions/openai-apps/src/app-server-invoker.ts`: per-invocation app-server session, turn execution, and final-text extraction
- `extensions/openai-apps/src/app-server-command.ts`: app-server command resolution before spawning the session

## Call path

### Phase 1: Resolve the published route

Trigger / entry condition:

- The MCP bridge receives `CallToolRequestSchema` for a tool name that should already have been published by `listTools`.

Entrypoints:

- `extensions/openai-apps/src/mcp-bridge.ts:ChatgptAppsMcpBridge.constructor`
- `extensions/openai-apps/src/mcp-bridge.ts:callTool`

Ordered call path:

1. Route the MCP request into `callTool(name, args)`.
   ```ts
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L216-L220
   this.server.setRequestHandler(
     CallToolRequestSchema,
     async (request) => await this.callTool(request.params.name, request.params.arguments),
   );
   ```
2. Recompute publication state and reuse the same tool cache contract that `listTools` uses.
   ```ts
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L239-L245
   publicationState := await this.getPublicationState()
   cache := await this.getToolCache(publicationState)
   route := cache.routes.get(name)
   if !route
     throw Error(`Unknown ChatGPT app tool: ${name}`)
   ```
3. Hand off the resolved route and current runtime context to the app-server invoker.
   ```ts
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L247-L259
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
   ```

State transitions / outputs:

- Input: MCP tool name plus tool arguments
- Output: resolved `AppServerInvocationRoute` or an immediate unknown-tool error

Branch points:

- Unknown tool names fail before any per-call app-server session is created.
- Publication-state refresh can still fail here because `callTool` shares `ensureFreshSnapshot(...)` with `listTools`.

External boundaries:

- None identified beyond in-process route/cache lookup

### Phase 2: Bootstrap the per-call app-server session

Trigger / entry condition:

- `callTool(...)` resolved a published route and entered `invokeViaAppServer(...)`.

Entrypoints:

- `extensions/openai-apps/src/app-server-invoker.ts:invokeViaAppServer`
- `extensions/openai-apps/src/app-server-command.ts:resolveAppServerCommand`

Ordered call path:

1. Resolve auth and the app-server binary before spawning anything.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L367-L389
   auth := await params.resolveProjectedAuth()
   if auth.status !== "ok"
     throw Error(auth.message)
   resolvedCommand := await resolveAppServerCommand({
     command: params.config.appServer.command,
     env,
   })
   writeDebugLog(env, `app-server command resolved command=${resolvedCommand} args=${params.config.appServer.args.join(" ")}`, params.statePaths.rootDir)
   ```
2. Reuse the bundle-owned `CODEX_HOME` and spawn the client with manual unhandled-request strategy.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L391-L437
   await mkdir(params.statePaths.codexHomeDir, { recursive: true })
   client := await clientFactory({
     command: resolvedCommand,
     args: params.config.appServer.args,
     cwd: params.workspaceDir,
     env: {
       ...env,
       CODEX_HOME: params.statePaths.codexHomeDir,
     },
   })
   // clientFactory defaults to CodexAppServerClient.spawn(..., { unhandledServerRequestStrategy: "manual" })
   ```
3. Initialize the app-server session, subscribe to auth refresh, log in, and ensure the derived app config has been written into the shared home for this gateway session before starting the turn.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L443-L488
   await client.initializeSession()
   unsubscribeRefresh := client.handleChatgptAuthTokensRefresh(async () => refreshedTokens)
   await client.loginAccount(toLoginParams(auth))
   wroteAppsConfig := await writeDerivedAppsConfig({
     config: params.config,
     writeConfigValue: writeParams => client.writeConfigValue(writeParams),
     appsConfigWriteGate: params.appsConfigWriteGate,
   })
   ```

State transitions / outputs:

- Input: resolved route, projected auth, `appServer.command/args`, runtime env, workspace dir
- Output: live per-call app-server client pointed at the bundle-owned `statePaths.codexHomeDir`, with the derived `apps` config written at most once per gateway session for the active config hash

Branch points:

- Auth failures abort the call before client spawn.
- Command resolution can return a discovered executable path or the raw configured command.
- `writeDerivedAppsConfig(...)` writes on the first tool call in a gateway session and reuses the existing shared-home config on later calls unless the resolved plugin config hash changes.

External boundaries:

- OpenAI Codex OAuth projection
- Child-process spawn through `CodexAppServerClient.spawn(...)`
- Bundle-owned filesystem state under `plugin-runtimes/openai-apps/codex-home`

### Phase 3: Guard server requests and run the turn

Trigger / entry condition:

- A live invocation client exists and is ready to accept turn-level work.

Entrypoints:

- `extensions/openai-apps/src/app-server-invoker.ts:invokeViaAppServer`

Ordered call path:

1. Register the explicit server-request policy for this invocation.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L490-L566
   handledServerRequests := new Set([
     "item/tool/requestUserInput",
     "item/permissions/requestApproval",
     "mcpServer/elicitation/request",
     "item/commandExecution/requestApproval",
     "item/fileChange/requestApproval",
     "account/chatgptAuthTokens/refresh",
   ])
   client.handleServerRequest("item/tool/requestUserInput", async context =>
     buildUserInputResponse(context.request.params)
   )
   client.handleServerRequest("item/permissions/requestApproval", async context => ({
     permissions: { ...requested network/fileSystem permissions... },
     scope: "turn",
   }))
   client.handleServerRequest("mcpServer/elicitation/request", async context =>
     resolveMcpServerElicitationResponse({
       mode: params.config.allowDestructiveActions,
       request: context.request.params,
       handleMcpServerElicitation: params.handleMcpServerElicitation,
     })
   )
   registerFailureHandler("item/commandExecution/requestApproval", () =>
     buildApprovalError("App invocation requested command approval")
   )
   registerFailureHandler("item/fileChange/requestApproval", () =>
     buildApprovalError("App invocation requested file change approval")
   )
   client.onServerRequest(async context => {
     if handledServerRequests.has(context.request.method)
       return
     serverRequestError ??= buildUnsupportedServerRequestError(...) ?? Error(`Unhandled server request: ${context.request.method}`)
     await context.respondError(error.message)
   })
   ```
2. Build the invocation input from the published route and user request.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L186-L210
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L568-L584
   request := typeof args?.request === "string" ? args.request.trim() : ""
   if !request
     throw Error('ChatGPT app tools require a non-empty "request" string')
   invocationInput := [
     {
       type: "text",
       text: `$${route.appInvocationToken} ${request}`,
       text_elements: [],
     },
     {
       type: "mention",
       name: route.appName,
       path: `app://${route.appId}`,
     },
   ]
   ```
3. Start a thread and run the turn under the fixed approval/output contract.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L586-L628
   threadStart := await client.startThread({
     cwd: params.workspaceDir ?? process.cwd(),
     approvalPolicy: APP_INVOCATION_APPROVAL_POLICY,
     developerInstructions: buildDeveloperInstructions(params.route),
     ephemeral: false,
     experimentalRawEvents: false,
     persistExtendedHistory: true,
   })
   threadId := threadStart.thread.id
   run := await client.runTurn(
     {
       threadId,
       cwd: params.workspaceDir ?? process.cwd(),
       approvalPolicy: APP_INVOCATION_APPROVAL_POLICY,
       outputSchema: CONNECTOR_OUTPUT_SCHEMA,
       input: invocationInput,
     },
     { timeoutMs: TURN_TIMEOUT_MS },
   )
   if serverRequestError
     throw serverRequestError
   if run.completed.turn.status !== "completed"
     throw buildUnsupportedServerRequestError(run.completed.turn.error?.message ?? null) ?? Error(run.completed.turn.error?.message ?? `Turn ended with status ${run.completed.turn.status}`)
   ```

State transitions / outputs:

- Input: logged-in app-server client plus resolved route and raw `args`
- Output: completed turn metadata and a thread id ready for final result extraction

Branch points:

- `item/tool/requestUserInput` is auto-answered instead of failing.
- `item/permissions/requestApproval` is mirrored back with requested permissions and `scope: "turn"`.
- `mcpServer/elicitation/request` is routed by `allow_destructive_actions`: auto-accepted for `"always"`, relayed outward for `"on-request"`, and declined for `"never"`.
- Command/file-change approvals and any unsupported server request are converted into stored `serverRequestError`.
- Empty `args.request` fails before `startThread(...)`.

External boundaries:

- App-server server-request callbacks
- App-server RPCs: `startThread`, `runTurn`

### Phase 4: Extract the final text and clean up

Trigger / entry condition:

- `runTurn(...)` completed without an earlier invocation guard failure.

Entrypoints:

- `extensions/openai-apps/src/app-server-invoker.ts:extractTurnText`
- `extensions/openai-apps/src/app-server-invoker.ts:invokeViaAppServer`

Ordered call path:

1. Read the completed thread and recover the final user-visible text.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L293-L344
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L630-L637
   thread := await client.readThread({ threadId, includeTurns: true })
   text := extractTurnText(thread, run.start.turn.id)
   extractTurnText(response, turnId) {
     turn := response.thread.turns.find(entry => entry.id === turnId)
     lastAgentMessage := [...turn.items].reverse().find(item => item.type === "agentMessage" && item.text.trim().length > 0)
     if lastAgentMessage
       parsed := try JSON.parse(lastAgentMessage.text)
       if parsed.status === "success" && typeof parsed.result === "string" && parsed.result.trim().length > 0
         return parsed.result
       if typeof parsed.error === "string" && parsed.error.trim().length > 0
         return parsed.error
       return lastAgentMessage.text
     lastToolResult := [...turn.items].reverse().find(item => item.type === "mcpToolCall" && item.result !== null)
     if lastToolResult?.result?.structuredContent !== null
       return JSON.stringify(lastToolResult.result.structuredContent, null, 2)
     if lastToolResult?.result?.content.length > 0
       return JSON.stringify(lastToolResult.result.content, null, 2)
     return null
   }
   if !text
     throw Error("App invocation completed without a usable final result")
   return { content: [{ type: "text", text }] }
   ```
2. Normalize any failure, then unsubscribe and close the client without deleting the shared home.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L643-L659
   catch error
     normalizedError := buildUnsupportedServerRequestError(error.message) ?? error
     writeDebugLog(env, `app-server invoke failed error=${message}`, params.statePaths.rootDir)
     throw normalizedError
   finally
     for unsubscribe of unsubscribeDebugListeners
       unsubscribe()
     for unsubscribe of unsubscribeHandlers
       unsubscribe()
     unsubscribeRefresh?.()
     await client.close()
   ```

State transitions / outputs:

- Input: completed turn id plus app-server thread id
- Output: MCP `CallToolResult` with one text item, or a normalized thrown error

Branch points:

- JSON `agentMessage` output is preferred when it matches the required schema.
- `mcpToolCall.result` becomes the fallback when no suitable final agent message exists.
- Missing final text is treated as a hard failure even if the turn status is `completed`.

External boundaries:

- App-server RPC `readThread`
- None identified beyond the shared bundle runtime directory already in use

## State

### Core state / ordering risks

- `route`: pulled from `cache.routes` in `callTool(...)` before `invokeViaAppServer(...)` runs, so the invocation uses the same published connector identity that `listTools()` exposed to the caller.
- `args.request`: validated by `readInvocationRequest(...)` before `startThread(...)`, so no thread/turn is created for empty requests.
- `statePaths.codexHomeDir`: created before `clientFactory(...)` and reused across refresh and invocation, so both paths target the same bundle-owned app-server home.
- Derived `apps` config: written after `loginAccount(...)` and before `startThread(...)`, so invocation does not depend on stale config from a prior refresh.
- `serverRequestError`: set during server-request callbacks and checked immediately after `runTurn(...)`, so unsupported requests are not hidden by a superficially successful turn status.
- `threadId` and `run.start.turn.id`: created before `readThread(...)`, so final text extraction always targets the exact turn that this invocation started.

### Runtime controls (or `None identified`)

| Name                                                                      | Kind          | Where Read                                                                                               | Effect on Flow                                                                        |
| ------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `plugins.entries["openai-apps"].config.appServer.command/args`            | config        | `extensions/openai-apps/src/mcp-bridge.ts#L247-L259`, `extensions/openai-apps/src/app-server-invoker.ts` | Chooses the app-server binary and argv used for each tool invocation.                 |
| `plugins.entries["openai-apps"].config.connectors`                        | config        | `extensions/openai-apps/src/mcp-bridge.ts#L285-L356`                                                     | Indirectly determines whether a tool route exists at all for the requested connector. |
| `workspaceDir` / current cwd                                              | runtime input | `extensions/openai-apps/src/app-server-invoker.ts`                                                       | Sets the thread cwd and child-process cwd for the invocation session.                 |
| `args.request`                                                            | request       | `extensions/openai-apps/src/app-server-invoker.ts`                                                       | Supplies the natural-language task appended after `$${route.appInvocationToken}`.     |
| `OPENCLAW_OPENAI_APPS_DEBUG=1`                                            | env           | `extensions/openai-apps/src/app-server-invoker.ts`                                                       | Mirrors invocation progress/errors to stderr in addition to the debug file.           |
| `OPENCLAW_SESSION_ID`, `OPENCLAW_CONVERSATION_ID`, `OPENCLAW_SESSION_KEY` | env           | `extensions/openai-apps/src/app-server-invoker.ts`                                                       | Only affect debug-log context by attaching a conversation/session identifier.         |

### Notable gates

- `cache.routes.get(name)`: fails unknown published tool names before spawning the app server (`extensions/openai-apps/src/mcp-bridge.ts#L239-L245`).
- `auth.status === "ok"`: required again for each invocation, even if route publication already succeeded (`extensions/openai-apps/src/app-server-invoker.ts#L375-L379`).
- `readInvocationRequest(...)`: enforces a non-empty `request` string (`extensions/openai-apps/src/app-server-invoker.ts#L186-L191`).
- `client.writeConfigValue(...)`: rewrites the derived `apps` config into the shared bundle-owned home before `startThread(...)`, so invocation does not depend on refresh having warmed the home first (`extensions/openai-apps/src/app-server-invoker.ts`).
- `handledServerRequests` policy: user-input requests are auto-answered, elicitations are declined, approval-bearing file/command requests are rejected, and unknown request types are surfaced as unsupported (`extensions/openai-apps/src/app-server-invoker.ts#L490-L566`).
- `run.completed.turn.status === "completed"` plus `extractTurnText(...) !== null`: both must succeed before `CallToolResult` is returned (`extensions/openai-apps/src/app-server-invoker.ts#L609-L637`).

## Sequence diagram

```
+----------------------+
| MCP callTool(name)   |
+----------------------+
           |
           v
+----------------------+
| resolve route cache  |
+----------------------+
           |
           v
+----------------------+
| resolve auth + cmd   |
| spawn shared-home    |
| client + write config|
+----------------------+
           |
           v
+------------------------------+
| register server-request      |
| policy + build invocation    |
| input                        |
+------------------------------+
           |
           v
+----------------------+
| startThread          |
| runTurn              |
+----------------------+
    | guarded error   | completed
    v                 v
+----------------+  +----------------------+
| throw error    |  | readThread           |
+----------------+  | extractTurnText      |
                    +----------------------+
                               |
                               v
                    +----------------------+
                    | return text content  |
                    | close client         |
                    +----------------------+
```

## Observability

Metrics:

- None identified in `extensions/openai-apps`; this path relies on debug logging rather than dedicated counters/timers.

Logs:

- `extensions/openai-apps/src/app-server-invoker.ts#L70-L89` appends invocation debug lines to `invocation-debug.log` under `statePaths.rootDir`, and optionally mirrors them to stderr when debug mode is enabled.
- `extensions/openai-apps/src/app-server-invoker.ts#L444-L459`, `extensions/openai-apps/src/app-server-invoker.ts#L547-L564`, `extensions/openai-apps/src/app-server-invoker.ts#L609-L639`, `extensions/openai-apps/src/app-server-invoker.ts#L643-L649` record stderr output, app-server close events, incoming server requests, turn completion, final-text success, and invocation failures.

## Related docs

- `extensions/openai-apps/docs/flows/ref.openai-apps-list-tools.md`

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-30: Created the `callTool` flow doc from `extensions/openai-apps` code only (019d3ffc-456e-7500-84dc-309b365ada15 - 966651ecb7)
- 2026-03-30: Updated the invocation flow for the shared bundle-owned `CODEX_HOME` and pre-turn `apps` config rewrite. (019d4036-0bb6-7a20-9dd6-933a0181e5a5 - afed18cb1c)
- 2026-03-30: Renamed the flow doc to `ref.openai-apps-call-tool.md` and updated related links. (019d4105-802e-7bd0-be7e-850070d63c37 - d78a1f3059)
