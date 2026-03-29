# Feature Spec: Milestone 2 - Long-Lived App Server and Cached Tool Publication

**Date:** 2026-03-28
**Status:** Planning

---

## Goal and Scope

### Goal

Implement the first end-to-end functional behavior for ChatGPT apps in
OpenClaw: the native `openai` service should lazily start and supervise
`codex app-server`, project OpenClaw-owned auth into it, refresh connector
inventory through `app/list`, persist a 24-hour connector snapshot, and let the
bundle publish only accessible and enabled tools from that snapshot.

### In Scope

- Port long-lived app-server supervision into the native `openai` service.
- Implement auth projection through `chatgptAuthTokens` from OpenClaw-owned
  `openai-codex` auth.
- Write the isolated derived sidecar config before refresh work.
- Implement paginated `app/list` refresh and optional `mcpServerStatus/list`
  capture in the same pass.
- Persist the connector snapshot with TTL and invalidation rules.
- Implement bundle-side `tools/list` publication from the service snapshot.
- Rewrite tool names into the local `chatgpt_app__<connectorId>__<toolName>`
  namespace.

### Out of Scope

- Remote MCP `tools/call` execution to the ChatGPT apps endpoint.
- Model-visible or operator-visible refresh UI beyond the control protocol.
- Replacing the local `file:` SDK dependency.
- Changing the OpenClaw runtime to understand plugin-owned MCP servers.

---

## Context and Constraints

### Background

Milestone 1 establishes the package split and control contract, but it does not
yet prove that ChatGPT apps can be discovered and surfaced as MCP tools.
Milestone 2 is the first milestone that must produce observable app-tool
publication behavior. It is where the design’s most important correctness
claims start to matter: OpenClaw remains the root auth sink, `app/list` remains
authoritative, and the bridge consumes a service-owned snapshot rather than
spawning its own sidecar.

### Current State

- The design defines the control contract, lazy startup, and service-owned
  snapshot boundaries in `docs/specs/2026-03-chatgpt-apps/design.md`.
- Milestone 1 is expected to provide the bundle package, service registration,
  path helpers, and basic control-protocol scaffolding.
- There is no connector snapshot yet, no `app/list` refresh implementation, and
  no real `tools/list` publication path for ChatGPT apps.

### Required Pre-Read

- `docs/specs/2026-03-chatgpt-apps/design.md`
- `docs/specs/2026-03-chatgpt-apps/milestone-1-native-service-and-bundle-skeleton-spec.md`
- `extensions/openai/chatgpt-apps/service.ts`
- `extensions/openai/chatgpt-apps/state-paths.ts`
- `extensions/openai/chatgpt-apps/control-protocol.ts`
- `extensions/openai-chatgpt-apps-bundle/src/server.ts`
- `extensions/openai-chatgpt-apps-bundle/src/service-client.ts`
- `src/plugin-sdk/config-runtime.ts`
- `src/plugin-sdk/provider-auth.ts`

### Constraints

- `app/list` is the only authoritative connector inventory source.
- The service, not the bundle, owns persisted connector snapshot files.
- Auth must be refreshed in OpenClaw before projection into the sidecar.
- The service starts at normal plugin-service startup, but must keep sidecar
  launch lazy until the first refresh-triggering request.
- Snapshot TTL is 24 hours unless a hard refresh is requested.
- Connector enablement must be reflected through the derived sidecar config so
  `AppInfo.isEnabled` matches OpenClaw config.

### Non-obvious Dependencies or Access

- A working `openai-codex` OAuth session with both access token and ChatGPT
  account id is required for live refresh validation.
- Local `codex app-server` must be invokable from the configured command path.
- The implementation depends on app-server protocol types from
  `/Users/kevinlin/code/codex-sdk-ts`.

---

## Approach and Touchpoints

### Proposed Approach

Extend the native service from Milestone 1 so that `snapshot/read` becomes a
real lazy refresh entrypoint. When the bridge requests a snapshot and none is
fresh, the service loads OpenClaw config, resolves `openai-codex` auth,
projects `chatgptAuthTokens` into `codex app-server`, writes the derived sidecar
config, runs paginated `app/list`, optionally captures `mcpServerStatus/list`,
persists the resulting snapshot, and returns it to the bridge. The bridge then
filters inaccessible or disabled connectors and publishes rewritten local tool
definitions.

The key simplification is to keep publication entirely snapshot-driven:

- service owns sidecar, refresh, and persistence
- bridge owns `tools/list` shaping only

Milestone 2 must make the following runtime contracts explicit:

- `snapshot/read` returns either a fresh snapshot payload or a typed refresh
  failure; the bridge must not infer readiness from filesystem state
- snapshot persistence is atomic and replaces the previous snapshot only after a
  successful refresh
- the bridge treats missing publication metadata as "connector not publishable"
  rather than guessing tool definitions from partial state

### Integration Points / Touchpoints

- `docs/specs/2026-03-chatgpt-apps/design.md`
  Why: source of truth for refresh ordering, cache boundaries, and ownership.
- `extensions/openai/chatgpt-apps/service.ts`
  Why: refresh orchestration, sidecar supervision, auth projection, and
  snapshot persistence live here.
- `extensions/openai/chatgpt-apps/control-protocol.ts`
  Why: `snapshot/read`, `snapshot/refresh`, and `health/read` gain real payloads.
- `extensions/openai/chatgpt-apps/state-paths.ts`
  Why: snapshot path and derived config path must stay deterministic.
- `extensions/openai/openclaw.plugin.json`
  Why: `chatgptApps` config drives base URL, app-server command, and connector
  enablement rules.
- `src/plugin-sdk/config-runtime.ts`
  Why: service-side config load and normalization.
- `src/plugin-sdk/provider-auth.ts`
  Why: service-side auth resolution and refresh.
- `extensions/openai-chatgpt-apps-bundle/src/service-client.ts`
  Why: bundle-side `snapshot/read` and `snapshot/refresh` integration.
- `extensions/openai-chatgpt-apps-bundle/src/mcp-bridge.ts`
  Why: `tools/list` publication from the service snapshot and local name
  rewriting.
- `extensions/openai-chatgpt-apps-bundle/src/config.ts`
  Why: bundle-side config hashing and filtering helpers.

### Resolved Ambiguities / Decisions

- Refresh trigger: `snapshot/read` may trigger refresh when no valid snapshot
  exists; `snapshot/refresh` always bypasses cached freshness.
- Refresh order: config load -> auth resolution -> sidecar ensure -> auth
  projection -> derived sidecar config write -> `app/list` -> optional
  `mcpServerStatus/list` -> snapshot persistence.
- Cache ownership: the bridge never reads `connectors.snapshot.json` directly.
- Publication filter: only connectors whose `AppInfo` is accessible and enabled
  are published.
- Tool naming: Milestone 2 already adopts the final local namespace
  `chatgpt_app__<connectorId>__<toolName>`.
- Partial metadata policy: if `mcpServerStatus/list` is unavailable and a
  connector cannot produce publishable tool metadata from the snapshot, that
  connector stays unpublished rather than falling back to guessed tools.

### Important Implementation Notes

- A missing ChatGPT account id is a hard refresh failure, not a soft skip.
- Failed refresh attempts must not leave partially written snapshot state that
  the bridge can accidentally publish.
- The bridge should rebuild its in-memory tool routing cache when the snapshot
  version changes, but Milestone 2 only needs that for `tools/list`, not yet
  for remote `tools/call`.
- `health/read` should expose enough data to debug cache freshness and sidecar
  reuse even if richer operator UI remains out of scope.

---

## Acceptance Criteria

- [ ] The native `openai` service starts `codex app-server` lazily on the first
      snapshot refresh and reuses it across later snapshot reads while healthy.
- [ ] The service refresh path projects OpenClaw-owned `openai-codex` auth into
      the sidecar and fails clearly when auth or account id is unavailable.
- [ ] The service writes derived sidecar config before `app/list` so connector
      enablement matches `plugins.entries.openai.config.chatgptApps`.
- [ ] A successful refresh persists a service-owned connector snapshot with TTL
      metadata and invalidation inputs.
- [ ] The bundle publishes only accessible and enabled ChatGPT app tools from
      the service snapshot, using rewritten local names.
- [ ] Failed refreshes do not replace the last known good snapshot or publish
      partial connector metadata.

---

## Phases and Dependencies

### Phase 1: Refresh Inputs and Sidecar Supervision

- [ ] Implement app-server command resolution and long-lived supervision in the
      native service.
- [ ] Resolve OpenClaw config and `openai-codex` auth inside the refresh path.
- [ ] Project `chatgptAuthTokens` into the sidecar before connector refresh.

### Phase 2: Snapshot Refresh and Persistence

- [ ] Write the derived sidecar config before refresh.
- [ ] Implement paginated `app/list`.
- [ ] Optionally capture `mcpServerStatus/list` in the same refresh pass.
- [ ] Persist the connector snapshot atomically with freshness metadata.
- [ ] Define the `snapshot/read` success and failure payload shapes and encode
      "no valid snapshot yet" distinctly from hard refresh failure.
- [ ] Apply TTL and invalidation rules for account change, config change, base
      URL change, and hard refresh.

### Phase 3: Bundle Tool Publication

- [ ] Implement bundle `snapshot/read` and `snapshot/refresh` consumption via
      `service-client.ts`.
- [ ] Implement `tools/list` publication from the service snapshot.
- [ ] Rewrite tool names into the local namespace.
- [ ] Filter out inaccessible or disabled connectors from publication.
- [ ] Treat connectors with incomplete publication metadata as unpublished and
      diagnostic rather than publishable by inference.

### Phase Dependencies

- Phase 2 depends on Phase 1 because snapshot refresh requires a real sidecar
  and auth-projection path.
- Phase 3 depends on Phase 2 because the bridge should publish from persisted
  snapshot state rather than ad hoc live calls.
- Milestone 3 depends on this milestone because remote `tools/call` needs the
  same connector metadata and route map generated here.

---

## Validation Plan

Integration tests:

- Verify the first `snapshot/read` on an empty state root launches the sidecar,
  refreshes connector state, and persists a snapshot.
- Verify repeated `snapshot/read` calls reuse the existing sidecar and cached
  snapshot while TTL remains valid.
- Verify config changes to connector enablement invalidate the snapshot and
  change the published toolset.
- Verify inaccessible or disabled connectors do not appear in `tools/list`.
- Verify a failed refresh preserves the prior good snapshot and does not publish
  partial replacement metadata.

Unit tests:

- Validate refresh ordering so derived sidecar config is written before
  `app/list`.
- Validate snapshot invalidation for config hash, account id, base URL, and
  hard-refresh trigger.
- Validate tool-name rewriting into
  `chatgpt_app__<connectorId>__<toolName>`.
- Validate failed refreshes do not leave publishable partial snapshots behind.
- Validate incomplete publication metadata results in unpublished connectors and
  diagnostics rather than guessed local tools.

Manual validation:

- Enable `plugins.entries.openai.config.chatgptApps.enabled` and confirm the
  first bundle-triggered `tools/list` launches the sidecar and persists a
  connector snapshot.
- Run `tools/list` again and confirm the service reuses the existing sidecar
  and cached snapshot.
- Toggle a connector enablement entry in OpenClaw config and confirm the next
  refresh changes the published ChatGPT app tools.
- Remove or invalidate OAuth state and confirm refresh fails clearly without
  publishing stale or partial tools.

---

## Done Criteria

- [ ] Milestone 2 implementation is complete and matches the acceptance
      criteria.
- [ ] Validation covers both successful refresh and failed refresh paths, with
      follow-up work captured for Milestone 3 where needed.
- [ ] The design doc, Milestone 1 spec, and Milestone 2 spec remain aligned on
      service-owned sidecar and snapshot boundaries.

---

## Open Items and Risks

### Open Items

- [ ] Decide whether `mcpServerStatus/list` should be required in the persisted
      snapshot or optional when unavailable.
- [ ] Decide whether snapshot freshness metadata needs a version field distinct
      from `fetchedAt`.

### Risks and Mitigations

| Risk                                                                                        | Impact | Probability | Mitigation                                                                                                   |
| ------------------------------------------------------------------------------------------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------ |
| Refresh ordering is wrong and `AppInfo.isEnabled` no longer reflects OpenClaw config        | High   | Med         | Encode the refresh order explicitly in service code and add tests for derived config write before `app/list` |
| Auth projection appears to succeed but uses stale or mismatched account context             | High   | Med         | Refresh auth in OpenClaw first, require account id, and persist account-based invalidation metadata          |
| Failed refresh leaves a half-written snapshot that the bridge publishes                     | High   | Med         | Write snapshots atomically and only replace the previous snapshot on successful completion                   |
| Tool publication leaks inaccessible connectors because filtering happens in the wrong layer | Med    | Med         | Keep `AppInfo`-based filtering in the bridge and test inaccessible/disabled cases explicitly                 |

### Simplifications and Assumptions

- Milestone 2 can treat remote tool execution as out of scope even if some tool
  metadata needed for route reconstruction is already captured in the snapshot.
- Sidecar recovery after process death can be limited to the next refresh path;
  no proactive background healing is required in this milestone.

---

## Outputs

- PR created from this spec: Not started

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-28: Created the Milestone 2 feature spec for lazy sidecar supervision, connector snapshot refresh, and cached tool publication. (019d37da-b9a9-72b1-9bda-231d842ceb58 - (2638b566f1694da1a8248efc99f7fc94fbb59b94))
