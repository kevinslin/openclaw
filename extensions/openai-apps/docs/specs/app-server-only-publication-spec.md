# Feature Spec: OpenAI Apps App-Server-Only Publication And Invocation

**Date:** 2026-03-29
**Status:** Planning

---

## Goal and Scope

### Goal

Remove the `appInvokePath` configuration switch and all direct ChatGPT apps MCP usage from `openai-apps`, so the bundle always uses `codex app-server` as the single authority for both `tools/list` and `tools/call`, publishes one local tool per connector in the `chatgpt_app_<connectorId>` namespace, and invokes apps using the documented app-server mention contract without ever subscribing to `item/tool/call`.

### In Scope

- Remove `plugins.entries.openai-apps.config.appInvokePath` from the config contract.
- Remove all direct internal ChatGPT apps MCP publish/call path usage from the bundle.
- Make `tools/list` derive its published tool set only from app-server-owned inventory/status data and publish one tool per connector.
- Make `tools/call` always route through the app-server invocation path with a fresh thread per local tool call and native app mention input.
- Update tests, docs, specs, and live validation guidance to reflect the app-server-only model.

### Out of Scope

- Changing OpenClaw core runtime under `src/`.
- Reintroducing any dual-mode compatibility switch.
- Any changes to OpenAI-side app-server protocol beyond consuming the documented app invocation contract.

---

## Context and Constraints

### Background

The current bundle exposes one published local tool surface, but it still has two internal backends:

- `tools/list` publishes from snapshot state that may fall back to direct remote MCP `tools/list`.
- `tools/call` switches between direct remote MCP and app-server orchestration based on `appInvokePath`.

That creates ambiguity during validation. A user can set `appInvokePath=appServer`, yet still see a tool inventory built from the remote MCP fallback, and the current app-server execution path still proxies nested `item/tool/call` requests through the remote MCP client. That means the bundle is not yet truly app-server-native, and the current published namespace is still shaped around remote MCP tool names rather than connector-level app invocation.

### Current State

- `extensions/openai-apps/src/config.ts` defines `appInvokePath: "appServer" | "remoteMCP"` and normalizes absent or invalid values to `"appServer"`.
- `extensions/openai-apps/src/mcp-bridge.ts:listTools()` does not consult `appInvokePath`; it always publishes from `getToolCache(...)`.
- `extensions/openai-apps/src/mcp-bridge.ts:buildToolCacheFromSnapshot(...)` can fall back to `listRemoteTools()` when snapshot `legacy app-status RPC` data is absent.
- `extensions/openai-apps/src/mcp-bridge.ts:buildDegradedToolCache(...)` always uses `listRemoteTools()`.
- `extensions/openai-apps/src/mcp-bridge.ts:callTool(...)` is the only place that checks `config.appInvokePath`.
- `extensions/openai-apps/src/app-server-session.ts` already has the app-server session plumbing needed for publication refresh.
- `extensions/openai-apps/src/app-server-invoker.ts` already creates a fresh non-ephemeral thread per invocation and runs the top-level turn through app-server, but it still handles nested `item/tool/call` by proxying to `remote-codex-apps-client.ts`.
- The published namespace is currently based on remote tool names (`chatgpt_app__<connectorId>__<toolName>`), which does not match the app-server-only model because app-server does not expose connector tool names for publication.

### Required Pre-Read

- `docs/flows/ref.openai-apps-call-tool.md`
- `docs/specs/2026-03-chatgpt-apps/app-invoke-path-spec.md`
- `extensions/openai-apps/src/mcp-bridge.ts`
- `extensions/openai-apps/src/app-server-session.ts`
- `extensions/openai-apps/src/app-server-invoker.ts`
- `extensions/openai-apps/src/config.ts`

### Constraints

- No changes under `src/`; all work stays inside the `openai-apps` bundle and docs/tests.
- No backwards compatibility is required. Removing `appInvokePath` is an intentional breaking change.
- `tools/list` and `tools/call` must both be explainable as app-server-driven behavior from the bundle’s perspective.
- The published tool namespace changes to `chatgpt_app_<connectorId>`.
- A fresh thread per local MCP tool invocation remains required.

### Non-obvious Dependencies or Access

- Live validation depends on a working `codex` app-server binary and valid `openai-codex` OAuth in the selected OpenClaw profile.
- Publication quality depends on `legacy app-status RPC` being available from app-server refresh sessions. If that data is unavailable, the bundle must fail hard rather than degrade or fall back.

---

## Approach and Touchpoints

### Proposed Approach

Collapse the bundle to a single backend model:

1. Config no longer exposes any invocation mode switch.
2. Snapshot refresh remains app-server-owned and becomes the only authority for publication inputs.
3. `listTools()` publishes only from app-server-derived persisted state and emits one tool per connector using `chatgpt_app_<connectorId>`.
4. `callTool()` always routes through `invokeViaAppServer(...)`.
5. `invokeViaAppServer(...)` invokes the app using the documented app-server contract:
   - add `$<app-slug>` to the text input
   - include a mention item with `path: app://<connector-id>`
6. Never register or subscribe to `item/tool/call` in the bundle.
7. Treat missing or incomplete `legacy app-status RPC` as a hard error instead of falling back.
8. Remove all direct ChatGPT apps MCP usage from the bundle.

This keeps the bundle model simple:

- app-server owns inventory
- app-server owns orchestration
- the bundle only republishes and adapts that behavior to OpenClaw MCP

Under the target model, the bundle should treat the local MCP tool call as a request to start a fresh app-server turn for one app. It should not act as a second remote MCP client during that turn, and it should not attempt to mirror remote MCP tool names into the published namespace.

### ASCII Diagram

```text
+-----------------------------+            +-----------------------------+
| tools/list from MCP host    |            | tools/call from MCP host    |
+-----------------------------+            +-----------------------------+
              |                                          |
              v                                          v
+-----------------------------+            +-----------------------------+
| mcp-bridge.listTools()      |            | mcp-bridge.callTool()       |
| no mode switch              |            | no mode switch              |
+-----------------------------+            +-----------------------------+
              |                                          |
              v                                          v
+-----------------------------+            +-----------------------------+
| ensureFreshSnapshot()       |            | resolve route from cached   |
| app-server refresh session  |            | app-server-backed snapshot  |
+-----------------------------+            +-----------------------------+
              |                                          |
              v                                          v
+-----------------------------+            +-----------------------------+
| app-server listApps()       |            | invokeViaAppServer()        |
| app-server mcpServerStatus  |            | spawn short-lived client    |
+-----------------------------+            +-----------------------------+
              |                                          |
              v                                          v
+-----------------------------+            +-----------------------------+
| persisted snapshot          |            | login + write apps config   |
| inventory + status gate     |            | start fresh thread          |
+-----------------------------+            +-----------------------------+
              |                                          |
              v                                          v
+-----------------------------+            +-----------------------------+
| publish one tool per app as |            | runTurn($app-slug +         |
| chatgpt_app_<connectorId>   |            | app:// mention)             |
+-----------------------------+            +-----------------------------+
              |                                          |
              v                                          v
+-----------------------------+            +-----------------------------+
| return published tool list  |            | readThread(includeTurns)    |
| from app-server state only  |            | return final text result    |
+-----------------------------+            +-----------------------------+
```

### Integration Points / Touchpoints

- `extensions/openai-apps/src/config.ts`
  Why: remove `appInvokePath` type/normalization and simplify config hashing inputs.
- `extensions/openai-apps/src/mcp-bridge.ts`
  Why: remove direct remote mode routing, remove remote publication fallback, and change the published namespace to one tool per connector.
- `extensions/openai-apps/src/app-server-session.ts`
  Why: becomes the sole source for publication-time inventory and status capture.
- `extensions/openai-apps/src/app-server-invoker.ts`
  Why: remains the only top-level invocation path for local tool calls and must be rewritten to use the native app-server app mention contract without `item/tool/call` handlers.
- `extensions/openai-apps/src/*.test.ts`
  Why: remove dual-mode expectations and rewrite tests around the single app-server path.
- `extensions/openai-apps/README.md`
  Why: remove configuration/docs that mention `appInvokePath` or `remoteMCP`.
- `docs/flows/ref.openai-apps-call-tool.md`
  Why: align the documented flow with the simplified architecture.

### Resolved Ambiguities / Decisions

- `appInvokePath` removal: remove it entirely from the config surface. Old configs that still set it are not supported.
- Publication authority: `tools/list` must be derived from app-server-owned snapshot data, not direct remote MCP `tools/list`.
- Published namespace: publish one local MCP tool per connector using `chatgpt_app_<connectorId>`, because app-server does not expose connector tool names for publication.
- Invocation authority: `tools/call` always uses `invokeViaAppServer(...)`; no bridge-level remote fallback remains.
- App invocation contract: invoke the app by putting `$<app-slug>` in the text input and include a mention item with `path: app://<connector-id>` so the server uses the exact app path instead of guessing by name.
- App slug derivation: derive the slug from the app name, lowercase it, and replace non-alphanumeric characters with `-` to match the documented app-server rule.
- `item/tool/call`: never register or subscribe to it in the bundle.
- Missing `legacy app-status RPC`: treat it as a hard error; do not degrade and do not fall back.
- Direct MCP usage: remove all direct ChatGPT apps MCP access from the bundle.
- Backwards compatibility: intentionally not preserved.

### Important Implementation Notes

- Today `buildToolCacheFromSnapshot(...)` falls back to `listRemoteTools()` when snapshot statuses are absent. That fallback must be removed and replaced with a hard error.
- Today `buildDegradedToolCache(...)` is fully remote-MCP-backed. It must be deleted rather than rewritten around another fallback.
- Today `invokeViaAppServer(...)` still installs an `item/tool/call` handler that proxies to `remote-codex-apps-client.ts`. That logic must be removed entirely.
- The text input envelope should follow the app-server format directly, for example:

```json
{
  "method": "turn/start",
  "params": {
    "threadId": "thread-1",
    "input": [
      {
        "type": "text",
        "text": "$demo-app Pull the latest updates from the team."
      },
      {
        "type": "mention",
        "name": "Demo App",
        "path": "app://demo-app"
      }
    ]
  }
}
```

- The publication contract should make it obvious why a tool is missing: lack of app-server inventory/status, connector disablement, or auth/refresh failure.
- The route model should no longer depend on remote tool names. It should carry connector/app identity plus the published connector-level tool name.

---

## Acceptance Criteria

- [ ] `plugins.entries.openai-apps.config` no longer accepts or documents `appInvokePath`; the bundle supports exactly one invocation model.
- [ ] `openai-apps` no longer contains a bridge-level execution path that directly calls remote ChatGPT apps MCP for `tools/call`.
- [ ] `openai-apps` no longer contains a bridge-level publication path that directly calls remote ChatGPT apps MCP `tools/list`.
- [ ] `tools/list` publishes one tool per connector in the `chatgpt_app_<connectorId>` namespace, using only app-server-derived inventory/status state.
- [ ] `tools/call` always executes through app-server turn orchestration, creates a fresh thread per local tool invocation, and uses `$<app-slug>` plus `app://<connector-id>` mention input to invoke the target app.
- [ ] The bundle never registers or subscribes to `item/tool/call`.
- [ ] Missing `legacy app-status RPC` fails publication as a hard error instead of degrading or falling back.
- [ ] Live validation can distinguish the single mode unambiguously via bundle logs and behavior, without a configuration switch.

---

## Phases and Dependencies

### Phase 1: Remove the config switch

- [ ] Delete `appInvokePath` from `ChatgptAppsConfig`, normalization, and config tests.
- [ ] Update README/spec/docs so the bundle documents only one mode.
- [ ] Remove tests that assert `remoteMCP` behavior as a supported option.

### Phase 2: Remove bridge-level remote publication

- [ ] Remove `listRemoteTools()` usage from publication-time tool-cache building.
- [ ] Delete `buildDegradedToolCache(...)` and replace it with hard-error behavior when app-server publication prerequisites are missing.
- [ ] Change the published namespace to `chatgpt_app_<connectorId>` and remove remote-tool-name-based route construction.
- [ ] Ensure `buildToolCacheFromSnapshot(...)` only uses persisted app-server-derived inventory/status inputs.

### Phase 3: Remove bridge-level remote invocation

- [ ] Delete the `callTool(...)` branch that routes directly to `remoteClient.callTool(...)`.
- [ ] Make `invokeViaAppServer(...)` the unconditional top-level execution path.
- [ ] Replace the current invocation envelope with the documented app-server contract: `$<app-slug>` in text plus `app://<connector-id>` mention input.
- [ ] Remove the `item/tool/call` proxy registration from the top-level app invocation path and never subscribe to `item/tool/call`.
- [ ] Remove `remote-codex-apps-client.ts` entirely.

### Phase 4: Validation and docs cleanup

- [ ] Update flow/spec docs to describe the single-mode model.
- [ ] Update live test guidance so “list all tools” and a real invocation both prove the same app-server-owned path.
- [ ] Re-run scoped tests and live connector checks for Gmail and Google Calendar.

### Phase Dependencies

- Phase 1 should land before implementation so tests/docs stop encoding the old dual-mode contract.
- Phase 2 and Phase 3 can proceed in parallel conceptually, but both depend on the publication/invocation degraded story being decided first.
- Phase 4 depends on the code and tests being fully simplified.

---

## Validation Plan

Integration tests:

- Verify `ChatgptAppsMcpBridge.listTools()` publishes one tool per connector in the `chatgpt_app_<connectorId>` namespace from app-server-derived snapshot/status data only.
- Verify `ChatgptAppsMcpBridge.callTool()` always routes through `invokeViaAppServer(...)`.
- Verify missing `legacy app-status RPC` fails publication as a hard error.
- Verify a published Gmail tool and a published Google Calendar tool both execute through the app-server path, invoke the target app via `$<app-slug>` plus mention input, and return successful results.

Unit tests:

- Verify config normalization no longer exposes `appInvokePath`.
- Verify tool-cache construction does not call remote `tools/list` and does not depend on remote tool names.
- Verify app-server invocation still starts a fresh non-ephemeral thread per local call.
- Verify app slug derivation matches the documented lowercased, non-alphanumeric-to-`-` rule.
- Verify invocation input includes both the `$<app-slug>` text marker and the exact `app://<connector-id>` mention item.
- Verify the published namespace is `chatgpt_app_<connectorId>`.
- Verify no `item/tool/call` handler is registered anywhere in the bundle.

Manual validation:

- Start the dev gateway with hard refresh enabled and confirm `list all tools` returns the expected published ChatGPT app tools.
- Invoke Gmail and Google Calendar app tools and confirm `plugin-runtimes/openai-apps/invocation-debug.log` shows app-server startup, thread creation, and turn completion.
- Confirm there is no remaining user-visible config path that selects `remoteMCP`.

---

## Done Criteria

- [ ] Implementation is complete and the bundle supports only the app-server-backed model.
- [ ] Validation proves both publication and invocation are app-server-owned from the bundle’s perspective.
- [ ] Docs/specs/tests are updated so they no longer describe or exercise the removed `remoteMCP` mode.

---

## Open Items and Risks

### Open Items

- [ ] None identified.

### Risks and Mitigations

| Risk                                                                                                                     | Impact | Probability | Mitigation                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| App-server refresh returns inventory but missing or incomplete `legacy app-status RPC`, causing hard publication failure | High   | Med         | Validate the failure mode explicitly and make the error actionable so operators know refresh must be fixed before tools can publish.       |
| Removing `appInvokePath` breaks local configs/tests/docs that still set it                                               | Med    | High        | Intentionally update config schema/tests/docs together and treat breakage as part of the migration, not as a compatibility bug.            |
| Publishing one connector-level tool per app reduces precision compared to the old per-tool namespace                     | Med    | Med         | Keep the tool description and prompt envelope explicit so the model knows each published tool is an app entrypoint, not a raw remote tool. |
| Live validation still feels ambiguous if logs are the only distinguishing signal                                         | Med    | Med         | Update test guidance so publication plus invocation are both traced through app-server-owned artifacts and logs.                           |

### Simplifications and Assumptions

- This spec assumes the bundle does not need to preserve old config files or old test fixtures that mention `appInvokePath`.
- This spec assumes app-server remains the correct long-term authority for both inventory publication and tool invocation.

---

## Outputs

- PR created from this spec: Not started

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-29: Added the feature spec for removing `appInvokePath` and the bridge-level `remoteMCP` path so `openai-apps` becomes app-server-only for both publication and invocation. (019d3acd-acf1-7fe2-b106-11d24d223a83 - 83ecd6e71a36)
- 2026-03-29: Updated the spec to require native app-server app invocation via `$<app-slug>` plus `app://<connector-id>` mention input, and to remove the top-level `item/tool/call` proxy assumption. (019d3acd-acf1-7fe2-b106-11d24d223a83 - 83ecd6e71a36)
- 2026-03-29: Updated the spec to publish one connector-level tool in the `chatgpt_app_<connectorId>` namespace, make missing `legacy app-status RPC` a hard error, and remove all direct ChatGPT apps MCP usage plus all `item/tool/call` subscription from the bundle. (019d3acd-acf1-7fe2-b106-11d24d223a83 - 83ecd6e71a36)
