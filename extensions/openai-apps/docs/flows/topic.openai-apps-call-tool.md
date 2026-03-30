# OpenAI Apps callTool Flow

Last updated: 2026-03-30

## Purpose

This flow documents how a published ChatGPT app tool is invoked after MCP `callTool` reaches the bundle. It answers where route metadata is resolved, how the per-call app-server session is constructed, and which guards can fail the invocation before a final text result is returned.

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
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L359-L381
   auth := await params.resolveProjectedAuth()
   if auth.status !== "ok"
     throw Error(auth.message)
   resolvedCommand := await resolveAppServerCommand({
     command: params.config.appServer.command,
     env,
   })
   writeDebugLog(env, `app-server command resolved command=${resolvedCommand} args=${params.config.appServer.args.join(" ")}`, params.statePaths.rootDir)
   ```
2. Create a temporary invocation-specific `CODEX_HOME` and spawn the client with manual unhandled-request strategy.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L383-L433
   await mkdir(params.statePaths.rootDir, { recursive: true })
   invocationCodexHomeDir := await mkdtemp(path.join(os.tmpdir(), "openclaw-openai-apps-invoke-"))
   client := await clientFactory({
     command: resolvedCommand,
     args: params.config.appServer.args,
     cwd: params.workspaceDir,
     env: {
       ...env,
       CODEX_HOME: invocationCodexHomeDir,
     },
   })
   // clientFactory defaults to CodexAppServerClient.spawn(..., { unhandledServerRequestStrategy: "manual" })
   ```
3. Initialize the app-server session, subscribe to auth refresh, and log in without writing derived app config.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L435-L480
   await client.initializeSession()
   unsubscribeRefresh := client.handleChatgptAuthTokensRefresh(async () => refreshedTokens)
   await client.loginAccount(toLoginParams(auth))
   writeDebugLog(env, "app-server config write skipped for invocation session", params.statePaths.rootDir)
   ```

State transitions / outputs:

- Input: resolved route, projected auth, `appServer.command/args`, runtime env, workspace dir
- Output: live per-call app-server client plus a temp `invocationCodexHomeDir`

Branch points:

- Auth failures abort the call before client spawn.
- Command resolution can return a discovered executable path or the raw configured command.

External boundaries:

- OpenAI Codex OAuth projection
- Child-process spawn through `CodexAppServerClient.spawn(...)`
- Temporary filesystem state under `/tmp/openclaw-openai-apps-invoke-*`

### Phase 3: Guard server requests and run the turn

Trigger / entry condition:

- A live invocation client exists and is ready to accept turn-level work.

Entrypoints:

- `extensions/openai-apps/src/app-server-invoker.ts:invokeViaAppServer`

Ordered call path:

1. Register the explicit server-request policy for this invocation.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L482-L558
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
   client.handleServerRequest("mcpServer/elicitation/request", async () => ({
     action: "decline",
     content: null,
     _meta: null,
   }))
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
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L178-L203
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L560-L576
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
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L578-L620
   threadStart := await client.startThread({
     cwd: params.workspaceDir ?? process.cwd(),
     approvalPolicy: "never",
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
       approvalPolicy: "never",
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
- `mcpServer/elicitation/request` is always declined.
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
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L285-L336
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L622-L634
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
2. Normalize any failure, then unsubscribe, close the client, and remove the temporary home directory.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L635-L652
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
     await rm(invocationCodexHomeDir, { recursive: true, force: true }).catch(() => {})
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
- Temporary filesystem cleanup for the invocation-specific `CODEX_HOME`

## State

### Core state / ordering risks

- `route`: pulled from `cache.routes` in `callTool(...)` before `invokeViaAppServer(...)` runs, so the invocation uses the same published connector identity that `listTools()` exposed to the caller.
- `args.request`: validated by `readInvocationRequest(...)` before `startThread(...)`, so no thread/turn is created for empty requests.
- `invocationCodexHomeDir`: created before `clientFactory(...)` and removed in `finally`, so per-call app-server state is isolated from the persistent refresh-side `codexHomeDir`.
- `serverRequestError`: set during server-request callbacks and checked immediately after `runTurn(...)`, so unsupported requests are not hidden by a superficially successful turn status.
- `threadId` and `run.start.turn.id`: created before `readThread(...)`, so final text extraction always targets the exact turn that this invocation started.

### Runtime controls (or `None identified`)

| Name                                                                      | Kind          | Where Read                                                                                                                 | Effect on Flow                                                                        |
| ------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `plugins.entries["openai-apps"].config.appServer.command/args`            | config        | `extensions/openai-apps/src/mcp-bridge.ts#L247-L259`, `extensions/openai-apps/src/app-server-invoker.ts#L373-L433`         | Chooses the app-server binary and argv used for each tool invocation.                 |
| `plugins.entries["openai-apps"].config.connectors`                        | config        | `extensions/openai-apps/src/mcp-bridge.ts#L285-L356`                                                                       | Indirectly determines whether a tool route exists at all for the requested connector. |
| `workspaceDir` / current cwd                                              | runtime input | `extensions/openai-apps/src/app-server-invoker.ts#L425-L433`, `extensions/openai-apps/src/app-server-invoker.ts#L578-L599` | Sets the thread cwd and child-process cwd for the invocation session.                 |
| `args.request`                                                            | request       | `extensions/openai-apps/src/app-server-invoker.ts#L178-L203`                                                               | Supplies the natural-language task appended after `$${route.appInvocationToken}`.     |
| `OPENCLAW_OPENAI_APPS_DEBUG=1`                                            | env           | `extensions/openai-apps/src/app-server-invoker.ts#L70-L89`                                                                 | Mirrors invocation progress/errors to stderr in addition to the debug file.           |
| `OPENCLAW_SESSION_ID`, `OPENCLAW_CONVERSATION_ID`, `OPENCLAW_SESSION_KEY` | env           | `extensions/openai-apps/src/app-server-invoker.ts#L49-L60`, `extensions/openai-apps/src/app-server-invoker.ts#L75-L89`     | Only affect debug-log context by attaching a conversation/session identifier.         |

### Notable gates

- `cache.routes.get(name)`: fails unknown published tool names before spawning the app server (`extensions/openai-apps/src/mcp-bridge.ts#L239-L245`).
- `auth.status === "ok"`: required again for each invocation, even if route publication already succeeded (`extensions/openai-apps/src/app-server-invoker.ts#L367-L370`).
- `readInvocationRequest(...)`: enforces a non-empty `request` string (`extensions/openai-apps/src/app-server-invoker.ts#L178-L184`).
- `handledServerRequests` policy: user-input requests are auto-answered, elicitations are declined, approval-bearing file/command requests are rejected, and unknown request types are surfaced as unsupported (`extensions/openai-apps/src/app-server-invoker.ts#L482-L558`).
- `run.completed.turn.status === "completed"` plus `extractTurnText(...) !== null`: both must succeed before `CallToolResult` is returned (`extensions/openai-apps/src/app-server-invoker.ts#L607-L634`).

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
| spawn temp client    |
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
                    | close + cleanup      |
                    +----------------------+
```

## Observability

Metrics:

- None identified in `extensions/openai-apps`; this path relies on debug logging rather than dedicated counters/timers.

Logs:

- `extensions/openai-apps/src/app-server-invoker.ts#L70-L89` appends invocation debug lines to `invocation-debug.log` under `statePaths.rootDir`, and optionally mirrors them to stderr when debug mode is enabled.
- `extensions/openai-apps/src/app-server-invoker.ts#L439-L455`, `extensions/openai-apps/src/app-server-invoker.ts#L542-L545`, `extensions/openai-apps/src/app-server-invoker.ts#L601-L605`, `extensions/openai-apps/src/app-server-invoker.ts#L639-L640` record stderr output, app-server close events, incoming server requests, turn completion, and invocation failures.

## Related docs

- `extensions/openai-apps/docs/flows/topic.openai-apps-list-tools.md`

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-30: Created the `callTool` flow doc from `extensions/openai-apps` code only (019d3ffc-456e-7500-84dc-309b365ada15 - 966651ecb7)
