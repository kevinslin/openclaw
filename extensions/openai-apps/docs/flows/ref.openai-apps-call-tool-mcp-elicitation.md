# OpenAI Apps MCP Elicitation During callTool Flow

Last updated: 2026-03-30

## Purpose

This flow documents what happens when the app-server tries to raise an MCP elicitation during the `callTool` invocation path. It answers why the invocation thread advertises `mcp_elicitations: true`, where `mcpServer/elicitation/request` is handled, how `allow_destructive_actions` changes the response path, and how that request affects the eventual turn result.

## Entry points

- `extensions/openai-apps/src/app-server-invoker.ts`: invocation approval policy, server-request handlers, and turn execution
- `extensions/openai-apps/src/mcp-bridge.ts`: upstream `callTool` handoff into `invokeViaAppServer(...)`

## Call path

### Phase 1: Enter the invocation path with elicitation enabled in approval policy

Trigger / entry condition:

- `ChatgptAppsMcpBridge.callTool(...)` has already resolved a published app route and entered `invokeViaAppServer(...)`.

Entrypoints:

- `extensions/openai-apps/src/mcp-bridge.ts:callTool`
- `extensions/openai-apps/src/app-server-invoker.ts:invokeViaAppServer`

Ordered call path:

1. Handoff from MCP `callTool` into the app-server invoker with the resolved route and request args.
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
2. Configure the invocation thread/turn approval policy so request-permission prompts and MCP elicitations are allowed to surface.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L29-L38
   APP_INVOCATION_APPROVAL_POLICY := {
     granular: {
       sandbox_approval: false,
       rules: false,
       skill_approval: false,
       request_permissions: true,
       mcp_elicitations: true,
     },
   }
   ```
3. Apply that policy when the invocation creates the thread and starts the turn.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L586-L607
   threadStart := await client.startThread({
     cwd: params.workspaceDir ?? process.cwd(),
     approvalPolicy: APP_INVOCATION_APPROVAL_POLICY,
     developerInstructions: buildDeveloperInstructions(params.route),
     ephemeral: false,
     experimentalRawEvents: false,
     persistExtendedHistory: true,
   })
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
   ```

State transitions / outputs:

- Input: resolved route, request args, and a logged-in invocation client
- Output: invocation thread/turn configured to allow the app-server to emit elicitation requests

Branch points:

- None in this phase; elicitation capability is always enabled by the fixed approval-policy constant. The destructive-action mode is resolved later from `allow_destructive_actions`, which defaults to `never` and supports `always`, `on-request`, and `never`.

External boundaries:

- App-server RPCs `startThread(...)` and `runTurn(...)`

### Phase 2: Register the elicitation handler and classify it as handled

Trigger / entry condition:

- The invocation client has been initialized, logged in, and configured.

Entrypoints:

- `extensions/openai-apps/src/app-server-invoker.ts:invokeViaAppServer`

Ordered call path:

1. Build the handled-method allowlist that includes `mcpServer/elicitation/request`.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L490-L498
   let serverRequestError := null
   handledServerRequests := new Set([
     "item/tool/requestUserInput",
     "item/permissions/requestApproval",
     "mcpServer/elicitation/request",
     "item/commandExecution/requestApproval",
     "item/fileChange/requestApproval",
     "account/chatgptAuthTokens/refresh",
   ])
   ```
2. Register a dedicated handler that maps `mcpServer/elicitation/request` through `allow_destructive_actions`.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts
   client.handleServerRequest("mcpServer/elicitation/request", async (context) => {
     return await resolveMcpServerElicitationResponse({
       mode: params.config.allowDestructiveActions,
       request: context.request.params,
       handleMcpServerElicitation: params.handleMcpServerElicitation,
     });
   });
   ```
3. Keep the generic `onServerRequest(...)` observer from treating elicitation as unsupported.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L547-L565
   client.onServerRequest(async context => {
     writeDebugLog(env, `app-server request method=${context.request.method} params=${serializeDebugValue(context.request.params)}`, params.statePaths.rootDir)
     if handledServerRequests.has(context.request.method)
       return
     error := buildUnsupportedServerRequestError(`Unhandled server request: ${context.request.method}`) ?? Error(`Unhandled server request: ${context.request.method}`)
     serverRequestError ??= error
     await context.respondError(error.message)
   })
   ```

State transitions / outputs:

- Input: initialized invocation client
- Output: a registered elicitation handler plus a generic observer that now treats elicitation as explicitly supported

Branch points:

- `mcpServer/elicitation/request` never sets `serverRequestError`; it is always considered handled.
- App-action elicitations are accepted for `"always"`, declined for `"never"`, or delegated outward for `"on-request"`.
- Unsupported methods outside the allowlist still become hard invocation errors.

External boundaries:

- App-server server-request callbacks

### Phase 3: Resolve the elicitation and let the turn continue or fail on its own

Trigger / entry condition:

- During `runTurn(...)`, the app-server emits `mcpServer/elicitation/request`.

Entrypoints:

- `extensions/openai-apps/src/app-server-invoker.ts:invokeViaAppServer`

Ordered call path:

1. Resolve the app-server request according to `allow_destructive_actions`.

   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts
   if allow_destructive_actions === "always"
     return { action: "accept", content: {}, _meta: null }
   if allow_destructive_actions === "never"
     return { action: "decline", content: null, _meta: null }
   return await handleMcpServerElicitation(request)
   ```

   - `always` auto-accepts the destructive action inside the invoker.
   - `never` auto-declines the destructive action inside the invoker.
   - `on-request` forwards the request to the outer MCP elicitation handler.

2. Surface the outer elicitation prompt with the app payload, then return accept or decline from the outer client.

   ```ts
   // Source: extensions/openai-apps/src/mcp-bridge.ts
   function buildDestructiveActionApprovalPrompt(...) {
     return {
       message: [
         `The ${connectorName} app requested approval for ${toolTitle}.`,
         ...,
         "App payload:",
         payload,
         "Choose accept to continue or decline to reject the action.",
       ].join("\n\n"),
       requestedSchema: {
         type: "object",
         properties: {},
       },
     };
   }

   async handleMcpServerElicitation(...) {
     const result = await this.server.elicitInput(buildDestructiveActionApprovalPrompt(elicitation));
     if (result.action !== "accept") {
       return { action: "decline", content: null, _meta: null };
     }
     return { action: "accept", content: {}, _meta: null };
   }
   ```

3. Resume normal turn completion handling after the request cycle finishes.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L609-L628
   if serverRequestError
     throw serverRequestError
   if run.completed.turn.status !== "completed"
     unsupportedServerRequestError := buildUnsupportedServerRequestError(run.completed.turn.error?.message ?? null)
     if unsupportedServerRequestError
       throw unsupportedServerRequestError
     throw Error(run.completed.turn.error?.message ?? `Turn ended with status ${run.completed.turn.status}`)
   ```
4. Only extract final text when the resolved elicitation did not cause the turn to fail.
   ```ts
   // Source: extensions/openai-apps/src/app-server-invoker.ts#L630-L649
   thread := await client.readThread({ threadId, includeTurns: true })
   text := extractTurnText(thread, run.start.turn.id)
   if !text
     throw Error("App invocation completed without a usable final result")
   return { content: [{ type: "text", text }] }
   ```

State transitions / outputs:

- Input: a live turn plus a server-raised elicitation request
- Output: either a completed invocation with final text, or a normal turn failure after the elicitation was accepted or declined

Branch points:

- Accepting or declining the elicitation does not itself fail the invocation; the decisive branch is still `run.completed.turn.status`.
- If the app-server reacts to the chosen response by failing the turn, that failure is surfaced through the standard post-turn error path.
- If the outer client does not support form elicitation, the request fails before the app-server receives an accept or decline.

External boundaries:

- App-server server-request cycle
- App-server RPC `readThread(...)`

## State

### Core state / ordering risks

- `APP_INVOCATION_APPROVAL_POLICY`: initialized before `startThread(...)` and `runTurn(...)`, so the app-server is allowed to ask for elicitation before any handler registration outcome matters.
- `handledServerRequests`: populated before `runTurn(...)` begins, so `mcpServer/elicitation/request` is classified as handled before the generic observer can mark it unsupported.
- `serverRequestError`: only written by unsupported methods or failure handlers; the elicitation handler never writes it, which is why a declined elicitation can still lead to a successful invocation.
- `run.completed.turn.status`: captured after all server-request callbacks finish and is the first consumer that determines whether the declined elicitation still let the turn complete.
- `text`: extracted only after a completed turn, so an elicitation that causes downstream failure never reaches final-text extraction.

### Runtime controls (or `None identified`)

| Name                         | Kind    | Where Read                                                                                                               | Effect on Flow                                                                |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `args.request`               | request | `extensions/openai-apps/src/mcp-bridge.ts#L247-L259`, `extensions/openai-apps/src/app-server-invoker.ts#L568-L583`       | Supplies the user task that may cause the app-server to raise an elicitation. |
| `OPENCLAW_OPENAI_APPS_DEBUG` | env     | `extensions/openai-apps/src/app-server-invoker.ts#L78-L97`, `extensions/openai-apps/src/app-server-invoker.ts#L550-L553` | Enables debug logging for incoming server requests, including elicitation.    |

### Notable gates

- `APP_INVOCATION_APPROVAL_POLICY.granular.mcp_elicitations === true`: permits elicitation requests to be surfaced at all (`extensions/openai-apps/src/app-server-invoker.ts#L30-L38`).
- `handledServerRequests.has("mcpServer/elicitation/request")`: keeps elicitation out of the unsupported-method error path (`extensions/openai-apps/src/app-server-invoker.ts#L491-L498`, `extensions/openai-apps/src/app-server-invoker.ts#L555-L557`).
- `run.completed.turn.status === "completed"`: decides whether the invocation survives the declined elicitation (`extensions/openai-apps/src/app-server-invoker.ts#L618-L628`).

## Sequence diagram

```
+------------------------+
| callTool -> invokeVia  |
| AppServer              |
+------------------------+
            |
            v
+------------------------+
| startThread / runTurn  |
| with mcp_elicitations  |
+------------------------+
            |
            v
+-------------------------------+
| app-server sends              |
| mcpServer/elicitation/request |
+-------------------------------+
            |
            v
+------------------------+
| bundle handler returns |
| action: decline        |
+------------------------+
      | turn still completes | turn fails later
      v                      v
+--------------------+   +--------------------+
| readThread + text  |   | surface turn error |
+--------------------+   +--------------------+
```

## Observability

Metrics:

- None identified.

Logs:

- `extensions/openai-apps/src/app-server-invoker.ts#L550-L553` writes each incoming server-request method and params into the invocation debug log.
- `extensions/openai-apps/src/app-server-invoker.ts#L648-L649` logs final invocation failure after post-turn normalization.

## Related docs

- `extensions/openai-apps/docs/flows/ref.openai-apps-call-tool.md`
- `extensions/openai-apps/docs/flows/ref.openai-apps-projected-auth.md`

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-30: Created the MCP elicitation during `callTool` flow doc (019d3ffc-456e-7500-84dc-309b365ada15 - 966651ecb7)
