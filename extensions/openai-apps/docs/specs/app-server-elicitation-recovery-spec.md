# Feature Spec: OpenAI Apps App-Server Elicitation Recovery

**Date:** 2026-03-30
**Status:** Planning

---

## Goal and Scope

### Goal

Make OpenAI Apps app-server invocations handle app-server elicitations correctly again, so connector calls can surface required connect or consent steps instead of silently suppressing them at thread or turn start.

### In Scope

- Fix the invocation-time approval policy so app-server can emit the server requests needed for connector connect flows.
- Define the bundle behavior for `mcpServer/elicitation/request` and `item/permissions/requestApproval` during `invokeViaAppServer(...)`.
- Reconcile invocation-session state with the published app-server snapshot where that ordering affects elicitation behavior.
- Add regression coverage that exercises real server-request sequencing instead of only mock handler return values.
- Update the related flow doc and spec set to match the actual behavior and limits.

### Out of Scope

- Reintroducing direct remote MCP `item/tool/call` execution.
- Changing command-execution or file-change approval policy beyond preserving the current hard-fail behavior.
- Broad approval-system redesign outside the OpenAI Apps invocation path.

---

## Context and Constraints

### Background

`extensions/openai-apps/docs/flows/ref.openai-apps-call-tool-mcp-elicitation.md` currently documents a path where the bundle receives `mcpServer/elicitation/request` and intentionally declines it. That flow does not describe the actual blocker in the live implementation: the invocation path now forces `approvalPolicy: "never"` at both `thread/start` and `turn/start`, which disables app-server approval-gated behavior before the registered elicitation handler becomes relevant.

The introducing commit, `768ef9f5493bc335a491b43202d9013d1d1e7717`, added three changes at once inside `extensions/openai-apps/src/app-server-invoker.ts`:

- it added explicit handlers for `item/tool/requestUserInput`, `item/permissions/requestApproval`, and `mcpServer/elicitation/request`
- it switched invocation threads and turns to `approvalPolicy: "never"`
- it moved each invocation into a fresh temporary `CODEX_HOME` and skipped the prior `apps` config write for that invocation session

Those changes conflict. The new handlers assume the server requests will reach the client; the new approval policy disables at least MCP elicitations at the thread and turn layer.

### Current State

- `extensions/openai-apps/src/app-server-invoker.ts` registers a handler for `mcpServer/elicitation/request`, but both `client.startThread(...)` and `client.runTurn(...)` set `approvalPolicy: "never"`.
- The SDK protocol defines `AskForApproval` as either a named policy or a granular object with a dedicated `mcp_elicitations` boolean, so `"never"` is stronger than “decline after receiving an elicitation”; it disables the category up front.
- `extensions/openai-apps/src/app-server-invoker.test.ts` still models a thread response whose effective policy has `mcp_elicitations: false`, which matches the live code path rather than the intended handler path.
- The same test file contains `it.todo("answers app-server user-input prompts instead of failing immediately")`, which is an explicit local signal that the mock-only handler addition did not become a working end-to-end flow.
- The invocation path now creates a fresh temporary `CODEX_HOME` and logs `app-server config write skipped for invocation session`, so invocation-time app state can diverge from the state used to publish the connector route.
- The app-server protocol exposes `thread/increment_elicitation` and `thread/decrement_elicitation` for out-of-band elicitation accounting, but the bundle does not use them today.

### Required Pre-Read

- `extensions/openai-apps/docs/flows/ref.openai-apps-call-tool-mcp-elicitation.md`
- `docs/research/2026-03-29-research-app-server-app-invocation-migration.md`
- `docs/specs/2026-03-chatgpt-apps/app-server-only-publication-spec.md`
- `extensions/openai-apps/src/app-server-invoker.ts`
- `extensions/openai-apps/src/app-server-invoker.test.ts`
- `node_modules/codex-app-server-sdk/dist/generated/protocol/v2/AskForApproval.d.ts`
- `node_modules/codex-app-server-sdk/dist/generated/protocol/v2/McpServerElicitationRequestParams.d.ts`
- `node_modules/codex-app-server-sdk/dist/generated/protocol/v2/McpServerElicitationRequestResponse.d.ts`

### Constraints

- The fix must preserve the app-server-only invocation model and must not reintroduce `item/tool/call` proxying.
- Connector invocations still need a fresh app-server thread per local MCP tool call.
- Command execution and file-change approval requests should remain hard failures.
- The implementation must work for non-interactive callers; if full interactive form relay is unavailable, the failure mode still has to be explicit and actionable.
- App-session state that affects app availability or approval behavior must be initialized before the thread snapshot that consumes it.

### Non-obvious Dependencies or Access (Optional)

- Live validation requires an account state where at least one connector can trigger a real connect or consent elicitation, for example Gmail on an unlinked account.
- If full form-mode elicitation relay requires a generic OpenClaw host surface, the implementation may need a small cross-cutting seam outside `extensions/openai-apps`.

### Temporal Context Check

| State value                | Source of truth                                         | Representation                 | Initialization point                                | Snapshot/capture point                            | First consumer                                                     | Initialized before consumer snapshot?        |
| -------------------------- | ------------------------------------------------------- | ------------------------------ | --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| Invocation approval policy | `invokeViaAppServer(...)`                               | `AskForApproval`               | before `thread/start` and again before `turn/start` | thread and turn creation                          | app-server approval and elicitation routing                        | Yes, but initialized to the wrong value      |
| Elicitation permission bit | `approvalPolicy.granular.mcp_elicitations` or `"never"` | boolean/effective policy       | same as above                                       | same as above                                     | app-server gating for `mcpServer/elicitation/request`              | Yes, but currently false by policy           |
| Invocation app config      | invocation session config under temporary `CODEX_HOME`  | `apps` config tree             | currently skipped                                   | thread config snapshot                            | app enablement and approval behavior inside the invocation session | No / unknown                                 |
| Published connector route  | snapshot inventory + status                             | connector id, app id, app slug | refresh/session before invocation                   | route resolution before `invokeViaAppServer(...)` | mention path and text prompt construction                          | Yes                                          |
| Elicitation payload        | app-server server request                               | `url` or `form` request params | during active turn                                  | request dispatch into client handler              | bundle relay or failure shaping                                    | Unknown today because policy blocks delivery |

The confirmed ordering bug is the invocation approval policy. The secondary ordering risk is the skipped invocation-session app-config write.

---

## Approach and Touchpoints

### Proposed Approach

Fix the elicitation path in three layers:

1. Replace the hard `"never"` policy override with a granular invocation policy that allows only the categories required for app connect flows.
2. Stop blindly declining `mcpServer/elicitation/request`; instead, translate the request into an actionable bundle-level outcome.
3. Align invocation-session config and tests with the real server-request order so future regressions fail in code review rather than after a live run.

The minimum viable policy is:

```ts
{
  granular: {
    sandbox_approval: false,
    rules: false,
    skill_approval: false,
    request_permissions: true,
    mcp_elicitations: true,
  },
}
```

That keeps the current “no sandbox/rules/skill approvals” posture while allowing the app-server categories that connector connect flows need.

For elicitation handling, the bundle should split behavior by mode:

- `mode: "url"`: do not silently decline. Surface the URL, message, server name, thread id, and elicitation id back to the caller in a structured and actionable result or failure shape.
- `mode: "form"`: relay through an existing user-input seam if one exists; otherwise return an explicit unsupported failure that includes the requested schema and message instead of pretending the flow succeeded.

If the implementation needs the app-server timeout to pause while an out-of-band connect step is active, add raw client calls for `thread/increment_elicitation` and `thread/decrement_elicitation` around the wait window.

### Integration Points / Touchpoints

- `extensions/openai-apps/src/app-server-invoker.ts`
  Why: owns thread start, turn start, server-request handling, temp `CODEX_HOME`, and final result shaping.
- `extensions/openai-apps/src/app-server-invoker.test.ts`
  Why: needs regression coverage for effective approval policy and actual elicitation request handling.
- `extensions/openai-apps/README.md`
  Why: currently documents `approvalPolicy: "never"` for invocation and will be incorrect after the fix.
- `extensions/openai-apps/docs/flows/ref.openai-apps-call-tool-mcp-elicitation.md`
  Why: currently describes a decline-only elicitation flow and should match the real post-fix contract.
- `docs/specs/2026-03-chatgpt-apps/app-server-only-publication-spec.md`
  Why: should link to the elicitation handling contract so the app-server-only model includes connect-flow behavior.
- `node_modules/codex-app-server-sdk/dist/generated/protocol/v2/AskForApproval.d.ts`
  Why: source-backed evidence for the policy-level `mcp_elicitations` gate.
- `node_modules/codex-app-server-sdk/dist/generated/protocol/v2/McpServerElicitationRequestParams.d.ts`
  Why: defines the `url` vs `form` request split the bundle must support.
- `node_modules/codex-app-server-sdk/dist/generated/protocol/v2/ThreadIncrementElicitationParams.d.ts`
  Why: defines the optional out-of-band pause-accounting path if the flow needs it.

### Resolved Ambiguities / Decisions

- Root cause classification: the confirmed root cause for live MCP elicitation failure is the hard `approvalPolicy: "never"` override on invocation threads and turns.
- `mcpServer/elicitation/request` behavior: blanket decline is not an acceptable steady-state behavior for connector connect flows.
- Command/file approvals: keep the existing hard-fail behavior; the fix should not broaden those capabilities.
- Remote MCP fallback: do not reopen `item/tool/call` or any direct remote MCP execution path as part of the elicitation fix.
- Invocation-session state: if app config meaningfully affects elicitation behavior, write or project that config into the temporary invocation session before thread creation.

### Important Implementation Notes (Optional)

- The existing flow doc is directionally wrong for the failing case because it starts from the handler registration path instead of the earlier policy gate.
- The introducing commit’s unit tests do not prove the live path. They only prove that a locally captured callback can return a response shape when manually invoked.
- The invocation session currently has no durable way to resume after an out-of-band elicitation. If full resume is deferred, the first implementation still has to return explicit connect metadata instead of silent failure.

---

## Acceptance Criteria

- [ ] `invokeViaAppServer(...)` no longer sends `approvalPolicy: "never"` on `thread/start` or `turn/start`; the effective invocation policy allows `request_permissions` and `mcp_elicitations` while keeping unrelated approval categories disabled.
- [ ] When app-server emits `item/permissions/requestApproval`, the bundle continues to approve only the requested network and file-system scopes for the active turn.
- [ ] When app-server emits `mcpServer/elicitation/request`, the bundle does not silently suppress or blanket-decline the request; `url` mode produces actionable connect metadata, and `form` mode is either relayed or rejected with an explicit unsupported error that preserves the prompt details.
- [ ] The invocation session initializes any required app config before the thread snapshot that depends on it, or the implementation documents and tests why that state is unnecessary.
- [ ] Regression coverage proves the effective policy and server-request behavior without relying only on manual callback invocation.
- [ ] The related flow/spec docs describe the real post-fix behavior and any remaining form-mode limitation accurately.

---

## Phases and Dependencies

### Phase 1: Correct the invocation policy

- [ ] Replace `"never"` with an explicit granular policy in both `client.startThread(...)` and `client.runTurn(...)`.
- [ ] Preserve hard failures for `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`.
- [ ] Add a regression test that asserts the exact invocation approval policy sent to app-server.

### Phase 2: Implement elicitation-aware result shaping

- [ ] Replace the blanket `mcpServer/elicitation/request` decline handler with mode-aware handling.
- [ ] Define the caller-visible shape for actionable URL elicitation output.
- [ ] Decide whether form-mode elicitation is supported now or returned as an explicit structured failure.
- [ ] Add integration-style tests that simulate real `mcpServer/elicitation/request` delivery and assert the resulting behavior.

### Phase 3: Reconcile invocation-session state

- [ ] Validate whether the temporary invocation `CODEX_HOME` needs an `apps` config write before thread creation.
- [ ] If needed, restore a scoped config projection into the invocation session.
- [ ] Add a regression test for the ordering: config projection before thread snapshot.

### Phase 4: Docs and live validation

- [ ] Update the request-flow doc and README to match the fixed policy and elicitation handling.
- [ ] Run a live validation against a connector that can trigger a connect or consent elicitation.
- [ ] Record the observed URL/form behavior and any remaining limitations in the spec set.

### Phase Dependencies

- Phase 1 must happen before any live elicitation validation because the current policy suppresses the target request class.
- Phase 2 depends on the Phase 1 policy correction.
- Phase 3 can be investigated in parallel with Phase 2, but it must be resolved before claiming the invocation session is behaviorally aligned with published app state.
- Phase 4 depends on the final behavior contract from Phases 2 and 3.

---

## Validation Plan

Integration tests:

- Assert `thread/start` is called with a granular approval policy whose `mcp_elicitations` and `request_permissions` bits are true.
- Assert `turn/start` uses the same effective approval policy and does not revert to `"never"`.
- Simulate `item/permissions/requestApproval` and verify the bundle returns only the requested permission classes with `scope: "turn"`.
- Simulate `mcpServer/elicitation/request` in `url` mode and verify the invocation returns actionable connect data instead of a silent decline.
- Simulate `mcpServer/elicitation/request` in `form` mode and verify the bundle either relays or returns an explicit unsupported error with prompt/schema context.
- Preserve the existing unsupported-request regression for `item/tool/call`.

Manual validation:

- Use an account state that triggers a Gmail or Google Drive connect flow and verify the local connector tool returns actionable elicitation output instead of an opaque failure.
- Verify a fully linked connector still completes the same request path without surfacing elicitation metadata.
- Confirm command-execution and file-change approvals still fail hard when requested.
- Confirm the updated flow doc matches the observed live sequence.

### Separate Validation Spec (Optional)

- Not required initially; fold the live validation notes into the current app-server spec set unless the matrix expands beyond one or two connectors.

---

## Done Criteria

- [ ] The implementation matches the acceptance criteria and removes the confirmed policy-level elicitation blocker.
- [ ] Regression and live validation results are captured or linked, and any deferred form-mode work is explicitly recorded.
- [ ] The related flow/spec/docs are updated so future work does not rely on the pre-fix decline-only model.

---

## Open Items and Risks

### Open Items

- [ ] Decide whether `form` mode elicitation can be relayed entirely within `extensions/openai-apps`, or whether it needs a generic OpenClaw user-input surface outside the bundle.
- [ ] Confirm whether invocation-session `apps` config affects elicitation behavior strongly enough that the skipped config write must be restored.
- [ ] Decide whether URL-mode flows need `thread/increment_elicitation` and `thread/decrement_elicitation` for timeout accounting in the first implementation.

### Risks and Mitigations

| Risk                                                                                       | Impact | Probability | Mitigation                                                                                     |
| ------------------------------------------------------------------------------------------ | ------ | ----------- | ---------------------------------------------------------------------------------------------- |
| Only fixing the handler and not the invocation policy leaves elicitation fully broken      | High   | High        | Make policy assertions a required regression test and an explicit acceptance criterion         |
| Temporary invocation `CODEX_HOME` still diverges from published app state after policy fix | High   | Med         | Validate config ordering and restore scoped config projection before thread creation if needed |
| Form-mode elicitation needs a core relay seam that is not available today                  | Med    | Med         | Ship URL-mode/actionable failure support first and record the core-seam dependency explicitly  |
| Tests keep mocking callback behavior instead of the real request sequence                  | Med    | High        | Add transport-level or client-level integration tests that simulate server requests in order   |
| Fixing elicitation accidentally broadens command/file approval behavior                    | High   | Low         | Keep explicit hard-fail handlers and assert them in regression coverage                        |

### Simplifications and Assumptions (Optional)

- This spec assumes the first implementation can treat URL-mode elicitation as the primary unblocker for connector connect flows.
- This spec assumes the live failure observed today is the policy-level suppression described above; if policy is corrected and elicitation still does not arrive, Phase 3 becomes mandatory rather than optional.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-30: Created feature spec for app-server elicitation recovery and documented the current policy-level blocker (019d3f72-244f-7913-9761-ed0696199227 - 6b8f753fdea93a5dc45cb5ae48e78d4d9f8c9190)
