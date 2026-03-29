# Feature Spec: Milestone 3 - Remote Tool Execution and Hardening

**Date:** 2026-03-28
**Status:** Planning

---

## Goal and Scope

### Goal

Turn the published ChatGPT app tools from Milestone 2 into fully executable MCP
tools by forwarding `tools/call` to the remote ChatGPT apps endpoint with
OpenClaw-owned auth, rebuilding route metadata after bridge restart, and adding
the minimum hard-refresh and diagnostics hardening needed for local dogfooding.

### In Scope

- Implement the bundle-side remote ChatGPT apps MCP client.
- Derive the correct ChatGPT apps endpoint from `chatgptBaseUrl`.
- Forward `tools/call` with OpenClaw-owned auth headers.
- Rebuild route metadata from the service snapshot after bridge restart.
- Add an operator/debug hard-refresh path through the existing control
  protocol.
- Preserve OpenClaw audit and tool-approval semantics for ChatGPT app tools.

### Out of Scope

- New OpenClaw runtime support for plugin-owned MCP servers.
- Rich operator UX for service inspection beyond diagnostics and hard refresh.
- Replacement of the local `file:` SDK dependency with a distributable package.
- Broader rollout beyond local and internal dogfooding.

---

## Context and Constraints

### Background

Milestone 2 makes ChatGPT app tools discoverable, but published tools are not
useful until the bridge can execute them. Milestone 3 closes that gap while
preserving the design’s trust boundary: the service still owns sidecar refresh
and connector inventory, while the bundle owns `tools/call` forwarding to the
remote ChatGPT apps endpoint. This milestone is also the first one where
OpenClaw transcript and approval semantics must be preserved during live tool
execution rather than only during publication.

### Current State

- The design defines separate service ownership for sidecar and snapshot state
  and separate bundle ownership for MCP exposure.
- Milestone 2 is expected to provide a stable connector snapshot, local tool
  naming, and `tools/list` publication from service-owned data.
- Remote `tools/call` execution, endpoint derivation, and route reconstruction
  after bridge restart are not yet implemented.

### Required Pre-Read

- `docs/specs/2026-03-chatgpt-apps/design.md`
- `docs/specs/2026-03-chatgpt-apps/milestone-2-long-lived-app-server-and-cached-tool-publication-spec.md`
- `extensions/openai-chatgpt-apps-bundle/src/mcp-bridge.ts`
- `extensions/openai-chatgpt-apps-bundle/src/service-client.ts`
- `extensions/openai-chatgpt-apps-bundle/src/config.ts`
- `extensions/openai-chatgpt-apps-bundle/src/remote-codex-apps-client.ts`
- `src/plugin-sdk/provider-auth.ts`

### Constraints

- The bundle must call the remote ChatGPT apps endpoint directly; it must not
  ask the native service to proxy tool execution.
- Auth continues to come from OpenClaw-owned `openai-codex` state.
- Endpoint derivation must follow the design’s `chatgptBaseUrl` rules exactly.
- Route metadata must remain recoverable from service snapshot state after
  bridge restart; bridge-local in-memory routing is not durable.
- Hard refresh should remain debug/operator-oriented and reuse the existing
  service control contract rather than introducing a model-visible refresh tool.

### Non-obvious Dependencies or Access

- Live validation requires working `openai-codex` OAuth state and at least one
  accessible ChatGPT connector with executable tools.
- The bridge must be able to resolve current auth at tool-call time, not only
  at publication time.

---

## Approach and Touchpoints

### Proposed Approach

Extend the bundle bridge so `tools/call` becomes a real remote execution path.
At tool-call time, the bridge resolves current OpenClaw auth, maps the local
tool name back to connector/tool identity using route metadata derived from the
service snapshot, derives the remote ChatGPT apps endpoint from
`chatgptBaseUrl`, sends the remote MCP call with the required auth headers, and
forwards the result through the normal MCP response path.

The bridge remains stateless except for in-memory route metadata:

- if the bridge has route metadata, it uses it
- if it restarts and loses that cache, it rebuilds from the latest service
  snapshot before executing the tool

Milestone 3 must make these execution contracts explicit:

- if auth resolution fails at call time, `tools/call` returns an MCP error and
  does not attempt a remote request
- if route reconstruction fails, `tools/call` returns an MCP error tied to the
  missing connector/tool route and does not guess from the local tool name
- if the remote endpoint returns an error, that error is surfaced as an MCP
  tool failure rather than an empty success payload
- after `snapshot/refresh` changes connector metadata, the bridge invalidates
  stale in-memory route mappings before the next execution

### Integration Points / Touchpoints

- `docs/specs/2026-03-chatgpt-apps/design.md`
  Why: source of truth for endpoint derivation, auth headers, and audit goals.
- `extensions/openai-chatgpt-apps-bundle/src/mcp-bridge.ts`
  Why: local tool routing, route reconstruction, and `tools/call` forwarding.
- `extensions/openai-chatgpt-apps-bundle/src/remote-codex-apps-client.ts`
  Why: remote endpoint derivation and transport client logic.
- `extensions/openai-chatgpt-apps-bundle/src/service-client.ts`
  Why: snapshot access and hard-refresh requests to the native service.
- `extensions/openai-chatgpt-apps-bundle/src/config.ts`
  Why: `chatgptBaseUrl` normalization and config hashing.
- `src/plugin-sdk/provider-auth.ts`
  Why: bridge-side auth resolution at execution time.
- `extensions/openai/chatgpt-apps/control-protocol.ts`
  Why: hard-refresh and health paths remain rooted in the existing service
  control contract.

### Resolved Ambiguities / Decisions

- Execution path: the bundle, not the native service, performs remote
  ChatGPT apps MCP `tools/call`.
- Auth timing: auth is resolved at execution time so stale bridge process state
  does not hold onto old tokens.
- Route recovery: route metadata is rebuilt from the service snapshot after
  bridge restart instead of introducing bridge-local persistence.
- Hard refresh: use `snapshot/refresh` on the service control protocol rather
  than adding a new model-visible tool.
- Endpoint derivation: follow the explicit `chatgptBaseUrl` mapping rules from
  the design doc.
- Error mapping: auth failure, route failure, and remote execution failure are
  separate execution outcomes and should remain distinguishable in diagnostics.

### Important Implementation Notes

- Execution failures from the remote endpoint must surface as MCP tool errors,
  not as silent empty outputs.
- Missing route metadata after bridge restart should trigger snapshot-based
  route reconstruction before failing.
- The bridge must not invent connector/tool routes from the local tool name
  without confirming against current service snapshot state.
- If a hard refresh changes connector or tool identity, any previously cached
  local route metadata must be invalidated before the next `tools/call`.

---

## Acceptance Criteria

- [ ] Published ChatGPT app tools execute end to end through the remote
      ChatGPT apps endpoint.
- [ ] The bridge resolves current OpenClaw-owned auth at `tools/call` time and
      forwards the required auth headers.
- [ ] Bridge restart does not permanently break executable tool routing because
      route metadata can be rebuilt from the service snapshot.
- [ ] A hard refresh request bypasses the cached connector snapshot and rebuilds
      service-owned snapshot state.
- [ ] OpenClaw still records ChatGPT apps as ordinary MCP tools for approval and
      transcript/audit purposes.
- [ ] Auth failure, route reconstruction failure, and remote execution failure
      surface as explicit MCP tool-call errors rather than ambiguous empty
      results.

---

## Phases and Dependencies

### Phase 1: Remote Client and Endpoint Derivation

- [ ] Implement `remote-codex-apps-client.ts`.
- [ ] Implement `chatgptBaseUrl` normalization and endpoint derivation rules.
- [ ] Validate the required auth header shape for remote calls.

### Phase 2: Executable Tool Routing

- [ ] Extend `mcp-bridge.ts` with real `tools/call` forwarding.
- [ ] Rebuild route metadata from service snapshot state when the bridge cache
      is missing.
- [ ] Fail clearly when route reconstruction cannot produce a valid target.
- [ ] Map auth failure, route failure, and remote endpoint failure into
      distinct MCP error paths.

### Phase 3: Hardening and Local Dogfood Support

- [ ] Add hard-refresh wiring through `snapshot/refresh`.
- [ ] Add diagnostics for route rebuild, remote execution failure, and auth
      resolution failure.
- [ ] Invalidate stale in-memory route metadata after hard refresh or snapshot
      change.
- [ ] Add manual validation coverage for real connector execution.

### Phase Dependencies

- Phase 2 depends on Phase 1 because executable routing requires a real remote
  client and endpoint derivation.
- Phase 3 depends on Phase 2 because hardening should cover the actual
  execution path, not a stub.
- This milestone depends on Milestone 2 for publishable connector metadata and
  service-owned snapshot state.

---

## Validation Plan

Integration tests:

- Verify `tools/call` forwards to a fake remote ChatGPT apps MCP endpoint with
  the expected derived URL and auth headers.
- Verify bridge restart followed by `tools/call` rebuilds route metadata from
  the service snapshot before executing.
- Verify `snapshot/refresh` bypasses cached freshness and causes later calls to
  use the rebuilt connector snapshot.
- Verify remote execution failures surface as MCP errors rather than silent
  empty results.
- Verify auth-resolution failure at call time does not attempt a remote request
  and surfaces an MCP error immediately.

Unit tests:

- Validate endpoint derivation for:
  - `https://chatgpt.com`
  - `https://chat.openai.com`
  - bases already ending in `/api/codex`
  - generic bases that require `/api/codex/apps`
- Validate route reconstruction from snapshot metadata.
- Validate auth-resolution failure handling at tool-call time.
- Validate route-cache invalidation after hard refresh or snapshot version
  change.

Manual validation:

- Execute a published ChatGPT app tool end to end against a live accessible
  connector and confirm the response comes back through normal MCP plumbing.
- Restart the bridge process and confirm the same tool remains executable.
- Trigger a hard refresh and confirm the next execution uses rebuilt connector
  metadata.
- Confirm the OpenClaw transcript records the tool call as ordinary MCP tool
  usage.
- Temporarily break auth or remove account context and confirm `tools/call`
  fails clearly without issuing a remote request.

---

## Done Criteria

- [ ] Milestone 3 implementation is complete and matches the acceptance
      criteria.
- [ ] Validation covers success, restart recovery, hard refresh, and remote
      failure paths.
- [ ] Dogfood instructions or follow-up notes capture any remaining limits of
      the local-only SDK dependency and operator refresh path.

---

## Open Items and Risks

### Open Items

- [ ] Decide whether `health/read` should report last remote execution failure
      or remain refresh-only.
- [ ] Decide whether route metadata in the snapshot should include an explicit
      snapshot version for bridge cache invalidation.

### Risks and Mitigations

| Risk                                                                             | Impact | Probability | Mitigation                                                                              |
| -------------------------------------------------------------------------------- | ------ | ----------- | --------------------------------------------------------------------------------------- |
| Endpoint derivation is subtly wrong for one supported base URL shape             | High   | Med         | Encode the derivation rules directly in tests for all supported forms                   |
| Bridge restart loses route metadata and produces false "tool not found" failures | High   | Med         | Rebuild route metadata from service snapshot before failing execution                   |
| Auth resolved at publish time drifts from auth at call time                      | High   | Med         | Resolve auth on every `tools/call` instead of caching tokens in bridge memory           |
| Hard refresh bypasses freshness but leaves bridge using stale in-memory routes   | Med    | Med         | Invalidate bridge route metadata whenever the snapshot changes after `snapshot/refresh` |

### Simplifications and Assumptions

- This milestone assumes the service snapshot from Milestone 2 already contains
  enough connector/tool metadata to rebuild route mappings without a live
  `app/list` call in the bridge.
- Hard refresh can remain an operator/debug path triggered outside the model
  surface for now.

---

## Outputs

- PR created from this spec: Not started

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-28: Created the Milestone 3 feature spec for remote ChatGPT app tool execution, route recovery, and execution hardening. (019d37da-b9a9-72b1-9bda-231d842ceb58 - (2638b566f1694da1a8248efc99f7fc94fbb59b94))
