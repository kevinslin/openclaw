# Feature Spec: Milestone 2 - On-Demand App-Server Refresh and Cached Tool Publication

**Date:** 2026-03-28
**Status:** Planning

---

## Goal and Scope

### Goal

Implement the first end-to-end functional behavior for ChatGPT apps in
OpenClaw: the bundle bridge should spawn a short-lived `codex app-server`
session on cache miss, project OpenClaw-owned auth into it, refresh connector
inventory through `app/list`, persist a 24-hour connector snapshot, and publish
only accessible and enabled tools from that snapshot.

### In Scope

- Port on-demand app-server refresh logic into the bundle bridge.
- Implement auth projection through `chatgptAuthTokens` from OpenClaw-owned
  `openai-codex` auth.
- Write the isolated derived sidecar config before refresh work.
- Implement paginated `app/list` refresh and optional `legacy app-status RPC`
  capture in the same pass.
- Persist the connector snapshot with TTL and invalidation rules.
- Implement bundle-side `tools/list` publication from the persisted snapshot.
- Rewrite tool names into the local `chatgpt_app__<connectorId>__<toolName>`
  namespace.

### Out of Scope

- Remote MCP `tools/call` execution to the ChatGPT apps endpoint.
- Any long-lived native service or shared control channel.
- Model-visible or operator-visible refresh UI beyond bundle-local hard-refresh
  flags or debug paths.
- Replacing the local `file:` SDK dependency.
- Changing the OpenClaw runtime to understand plugin-owned managed MCP servers.

---

## Context and Constraints

### Background

Milestone 1 establishes the bundle package, config contract, and bundle-owned
state root, but it does not yet prove that ChatGPT apps can be discovered and
surfaced as MCP tools. Milestone 2 is the first milestone that must produce
observable app-tool publication behavior. It is where the design’s most
important correctness claims start to matter: OpenClaw remains the root auth
sink, `app/list` remains authoritative, and the bridge consumes its own
persisted snapshot rather than any background native service.

### Current State

- The design defines the bundle-owned refresh transaction and persisted snapshot
  boundaries in `docs/specs/2026-03-chatgpt-apps/design.md`.
- Milestone 1 is expected to provide the bundle package, path helpers, config
  schema, and basic bridge scaffolding.
- There is no connector snapshot yet, no `app/list` refresh implementation, and
  no real `tools/list` publication path for ChatGPT apps.

### Required Pre-Read

- `docs/specs/2026-03-chatgpt-apps/design.md`
- `docs/specs/2026-03-chatgpt-apps/milestone-1-native-service-and-bundle-skeleton-spec.md`
- `extensions/openai-chatgpt-apps-bundle/src/server.ts`
- `extensions/openai-chatgpt-apps-bundle/src/config.ts`
- `extensions/openai-chatgpt-apps-bundle/src/state-paths.ts`
- `extensions/openai-chatgpt-apps-bundle/src/app-server-command.ts`
- `extensions/openai-chatgpt-apps-bundle/src/auth-projector.ts`
- `src/plugin-sdk/config-runtime.ts`
- `src/plugin-sdk/provider-auth.ts`

### Constraints

- `app/list` is the only authoritative connector inventory source.
- The bundle, not a native service, owns persisted connector snapshot files.
- Auth must be refreshed in OpenClaw before projection into the sidecar.
- The app-server should be launched only inside refresh work and torn down after
  that refresh completes.
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

Extend the bundle bridge from Milestone 1 so `ensureFreshSnapshot()` becomes a
real lazy refresh entrypoint. When the bridge needs a snapshot and none is
fresh, it loads OpenClaw config, resolves `openai-codex` auth, projects
`chatgptAuthTokens` into a short-lived `codex app-server` session, writes the
derived sidecar config, runs paginated `app/list`, optionally captures
`legacy app-status RPC`, persists the resulting snapshot, and then publishes
rewritten local tool definitions from that persisted state.

The key simplification is to keep publication entirely snapshot-driven:

- the bridge owns refresh and persistence
- the bridge owns `tools/list` shaping
- the sidecar exists only during refresh work

Milestone 2 must make the following runtime contracts explicit:

- `ensureFreshSnapshot()` returns either a fresh snapshot payload or a typed
  refresh failure; publication logic must not infer readiness from ad hoc file
  existence checks alone
- snapshot persistence is atomic and replaces the previous snapshot only after a
  successful refresh
- the bridge treats missing publication metadata as "connector not publishable"
  rather than guessing tool definitions from partial state

### Integration Points / Touchpoints

- `docs/specs/2026-03-chatgpt-apps/design.md`
  Why: source of truth for refresh ordering, cache boundaries, and ownership.
- `extensions/openai/openclaw.plugin.json`
  Why: `chatgptApps` config drives base URL, app-server command, and connector
  enablement rules.
- `extensions/openai-chatgpt-apps-bundle/src/server.ts`
  Why: bundle startup, hard-refresh input, and bridge construction live here.
- `extensions/openai-chatgpt-apps-bundle/src/config.ts`
  Why: config load, normalization, and hash computation.
- `extensions/openai-chatgpt-apps-bundle/src/state-paths.ts`
  Why: snapshot path and derived config path must stay deterministic.
- `extensions/openai-chatgpt-apps-bundle/src/app-server-command.ts`
  Why: sidecar command resolution lives here.
- `extensions/openai-chatgpt-apps-bundle/src/app-server-session.ts`
  Why: short-lived refresh-side sidecar lifecycle lives here.
- `extensions/openai-chatgpt-apps-bundle/src/auth-projector.ts`
  Why: refresh-time auth projection into the sidecar.
- `extensions/openai-chatgpt-apps-bundle/src/refresh-snapshot.ts`
  Why: refresh orchestration, sidecar use, and snapshot persistence live here.
- `extensions/openai-chatgpt-apps-bundle/src/snapshot-cache.ts`
  Why: persisted snapshot IO, TTL checks, and invalidation helpers.
- `extensions/openai-chatgpt-apps-bundle/src/mcp-bridge.ts`
  Why: `tools/list` publication from snapshot and local name rewriting.
- `src/plugin-sdk/config-runtime.ts`
  Why: bundle-side config load and normalization.
- `src/plugin-sdk/provider-auth.ts`
  Why: bundle-side auth resolution and refresh.

### Resolved Ambiguities / Decisions

- Refresh trigger: snapshot refresh happens on `tools/list`, route rebuild, or
  explicit hard-refresh bypass when no valid snapshot is available.
- Refresh order: config load -> auth resolution -> sidecar spawn -> auth
  projection -> derived sidecar config write -> `app/list` -> optional
  `legacy app-status RPC` -> snapshot persistence -> sidecar teardown.
- Cache ownership: the bundle is the only reader and writer of
  `connectors.snapshot.json`.
- Publication filter: only connectors whose `AppInfo` is accessible and enabled
  are published.
- Tool naming: Milestone 2 already adopts the final local namespace
  `chatgpt_app__<connectorId>__<toolName>`.
- Partial metadata policy: `legacy app-status RPC` is required for publication.
  Missing or incomplete status data is a hard publication failure rather than a
  partial publish.

### Important Implementation Notes

- A missing ChatGPT account id is a hard refresh failure, not a soft skip.
- Failed refresh attempts must not leave partially written snapshot state that
  the bridge can accidentally publish.
- The bridge should rebuild its in-memory tool routing cache when the snapshot
  version changes, even though Milestone 2 only needs that for `tools/list`.
- Concurrent refresh sessions may do duplicate refresh work in the first
  version; atomic snapshot replacement keeps persisted state coherent.

---

## Acceptance Criteria

- [ ] The bundle launches `codex app-server` only inside refresh work and tears
      it down after a successful or failed refresh attempt.
- [ ] The refresh path projects OpenClaw-owned `openai-codex` auth into the
      sidecar and fails clearly when auth or account id is unavailable.
- [ ] The bundle writes derived sidecar config before `app/list` so connector
      enablement matches `plugins.entries.openai.config.chatgptApps`.
- [ ] A successful refresh persists a bundle-owned connector snapshot with TTL
      metadata and invalidation inputs.
- [ ] The bundle publishes only accessible and enabled ChatGPT app tools from
      the persisted snapshot, using rewritten local names.
- [ ] Failed refreshes do not replace the last known good snapshot or publish
      partial connector metadata.

---

## Phases and Dependencies

### Phase 1: Refresh Inputs and Short-Lived Sidecar Session

- [ ] Implement app-server command resolution in the bundle package.
- [ ] Implement short-lived sidecar session handling for refresh work.
- [ ] Resolve OpenClaw config and `openai-codex` auth inside the refresh path.
- [ ] Project `chatgptAuthTokens` into the sidecar before connector refresh.

### Phase 2: Snapshot Refresh and Persistence

- [ ] Write the derived sidecar config before refresh.
- [ ] Implement paginated `app/list`.
- [ ] Optionally capture `legacy app-status RPC` in the same refresh pass.
- [ ] Persist the connector snapshot atomically with freshness metadata.
- [ ] Define the `ensureFreshSnapshot()` success and failure result shapes and
      encode "no valid snapshot yet" distinctly from hard refresh failure.
- [ ] Apply TTL and invalidation rules for account change, config change, base
      URL change, and hard refresh.

### Phase 3: Bundle Tool Publication

- [ ] Implement `tools/list` publication from the persisted snapshot.
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

- Verify the first `tools/list` on an empty state root launches the sidecar,
  refreshes connector state, persists a snapshot, and tears the sidecar down.
- Verify repeated `tools/list` calls reuse the cached snapshot while TTL remains
  valid and do not spawn the sidecar again.
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
  first bundle-triggered `tools/list` launches the sidecar, persists a
  connector snapshot, and then exits the sidecar session.
- Run `tools/list` again and confirm the bundle reuses the cached snapshot.
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
      bundle-owned sidecar and snapshot boundaries.

---

## Open Items and Risks

### Open Items

- [ ] Decide whether `legacy app-status RPC` should be required in the persisted
      snapshot or optional when unavailable. - Answer: not required.
- [ ] Decide whether snapshot freshness metadata needs a version field distinct
      from `fetchedAt`.

### Risks and Mitigations

| Risk                                                                                        | Impact | Probability | Mitigation                                                                                                   |
| ------------------------------------------------------------------------------------------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------ |
| Refresh ordering is wrong and `AppInfo.isEnabled` no longer reflects OpenClaw config        | High   | Med         | Encode the refresh order explicitly in bridge code and add tests for derived config write before `app/list`  |
| Auth projection appears to succeed but uses stale or mismatched account context             | High   | Med         | Refresh auth in OpenClaw first, require account id, and persist account-based invalidation metadata          |
| Failed refresh leaves a half-written snapshot that the bridge publishes                     | High   | Med         | Write snapshots atomically and only replace the previous snapshot on successful completion                   |
| Tool publication leaks inaccessible connectors because filtering happens in the wrong layer | Med    | Med         | Keep `AppInfo`-based filtering in the bridge and test inaccessible/disabled cases explicitly                 |
| Multiple bridge processes duplicate refresh work                                            | Med    | Med         | Accept bounded duplication initially and rely on TTL plus atomic snapshot replacement to keep state coherent |

### Simplifications and Assumptions

- Milestone 2 can treat remote tool execution as out of scope even if some tool
  metadata needed for route reconstruction is already captured in the snapshot.
- Cross-process refresh deduplication is not required in this milestone.

---

## Outputs

- PR created from this spec: Not started

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-28: Updated Milestone 2 to a bundle-owned refresh transaction with short-lived app-server sessions and persisted snapshot publication, removing native service supervision from scope. (019d37da-b9a9-72b1-9bda-231d842ceb58 - (cc55b9534a))
- 2026-03-28: Created the Milestone 2 feature spec for lazy sidecar supervision, connector snapshot refresh, and cached tool publication. (019d37da-b9a9-72b1-9bda-231d842ceb58 - (2638b566f1694da1a8248efc99f7fc94fbb59b94))
