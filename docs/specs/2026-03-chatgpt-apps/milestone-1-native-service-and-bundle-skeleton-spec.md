# Feature Spec: Milestone 1 - Native Service and Bundle Skeleton

**Date:** 2026-03-28
**Status:** Planning

---

## Goal and Scope

### Goal

Land the minimum plugin-only structure needed to expose ChatGPT apps through a
separate Codex bundle while keeping app-server ownership in the existing native
`openai` plugin via `registerService(...)`. Milestone 1 should establish the
package layout, shared control contract, config schema, and lightweight service
startup behavior without yet requiring full connector refresh or remote tool
execution.

### In Scope

- Add a separate bundle package root for ChatGPT apps under `extensions/`.
- Add native `openai` plugin service registration for ChatGPT apps.
- Define the shared namespaced state layout and control protocol between the
  native service and the bundle bridge.
- Extend `extensions/openai/openclaw.plugin.json` with the `chatgptApps`
  config schema needed by later milestones.
- Add the local `file:/Users/kevinlin/code/codex-sdk-ts` dependency in the new
  bundle package for local development.
- Keep the native service lightweight at startup so it does not eagerly spawn
  `codex app-server`.

### Out of Scope

- Full `app/list` pagination and persisted connector snapshot refresh logic.
- Remote ChatGPT apps MCP `tools/call` execution.
- End-to-end connector publication through real app inventory.
- Any OpenClaw runtime changes under `src/` beyond consuming existing plugin
  SDK surfaces.
- CI- or marketplace-ready replacement for the local `file:` SDK dependency.

---

## Context and Constraints

### Background

The design for `docs/specs/2026-03-chatgpt-apps/design.md` intentionally moved
away from the earlier native-plugin-heavy approach because that version added
runtime seams and a new `service` concept to OpenClaw core. The approved design
keeps the good parts of the prior branch, especially app-server supervision and
OpenClaw-owned auth projection, but requires all new behavior to stay inside
plugin code. Milestone 1 is the enabling step that creates the service-plus-
bundle split without taking dependency on connector refresh behavior being
finished yet.

### Current State

- `extensions/openai/index.ts` registers providers and a CLI backend, but no
  ChatGPT apps service.
- `extensions/openai/openclaw.plugin.json` has an empty plugin config schema.
- Bundle MCP support already exists via `.codex-plugin/plugin.json` and
  `.mcp.json`, merged into embedded Pi config by existing bundle loading code.
- Plugin services already exist and start with a shared `stateDir` via
  `src/plugins/services.ts` and `src/plugins/types.ts`.
- There is no plugin-specific runtime state root; any service/bundle shared
  state must be namespaced under the existing shared state directory.

### Required Pre-Read

- `docs/specs/2026-03-chatgpt-apps/design.md`
- `extensions/openai/index.ts`
- `extensions/openai/openclaw.plugin.json`
- `src/plugins/services.ts`
- `src/plugins/types.ts`
- `src/plugins/bundle-mcp.ts`
- `src/agents/embedded-pi-mcp.ts`

### Constraints

- Only plugin code should change. No new runtime primitives in `src/`.
- The native `openai` package cannot also be the bundle root because native
  manifests win over `.codex-plugin/plugin.json`.
- `registerService(...)` starts with normal plugin service startup, so the
  ChatGPT apps service must be safe and cheap when enabled but unused.
- The service and the bundle must agree on one deterministic shared-state root.
- `file:/Users/kevinlin/code/codex-sdk-ts` is acceptable for local work but not
  portable to CI or broader distribution.

### Non-obvious Dependencies or Access

- Local access to `/Users/kevinlin/code/codex-sdk-ts` is required to install the
  new bundle package as designed.
- Later milestones depend on valid `openai-codex` OAuth state, but Milestone 1
  should not require live auth to validate startup behavior and package wiring.

---

## Approach and Touchpoints

### Proposed Approach

Create a new bundle package under `extensions/openai-chatgpt-apps-bundle/` that
declares exactly one stdio MCP server and contains the future bridge entrypoint.
At the same time, add a lightweight ChatGPT apps service to the native
`openai` plugin. The service owns a deterministic shared-state directory and
publishes control metadata, but does not start `codex app-server` until the
bridge asks for connector state. This milestone should leave later refresh and
execution code as stubs or thin scaffolding, but the ownership and file layout
must be final enough that Milestones 2 and 3 do not need to rethink the seam.

Milestone 1 must produce these concrete artifacts and invocation contracts:

- the native service `start(...)` creates
  `${STATE_DIR}/plugin-runtimes/openai-chatgpt-apps/`
- the native service atomically writes `control.json` in that directory during
  startup
- the native service defines, but does not yet fully exercise, the control
  methods `snapshot/read`, `snapshot/refresh`, and `health/read`
- the bundle bridge entrypoint reads `control.json` first and never reads
  snapshot files directly
- if `control.json` is missing or invalid, the bridge returns no app tools and
  emits diagnostics instead of spawning fallback behavior

### Integration Points / Touchpoints

- `docs/specs/2026-03-chatgpt-apps/design.md`
  Why: source of truth for the service/bundle architecture and milestone scope.
- `extensions/openai/index.ts`
  Why: native plugin entrypoint where `registerService(...)` must be added.
- `extensions/openai/openclaw.plugin.json`
  Why: host schema for `plugins.entries.openai.config.chatgptApps`.
- `extensions/openai/chatgpt-apps/service.ts`
  Why: new lightweight service owner for shared-state setup and future
  app-server supervision.
- `extensions/openai/chatgpt-apps/state-paths.ts`
  Why: shared deterministic path helpers used by both native service and
  bundle code.
- `extensions/openai/chatgpt-apps/control-protocol.ts`
  Why: typed control request and response contract for `snapshot/read`,
  `snapshot/refresh`, and `health/read`.
- `extensions/openai-chatgpt-apps-bundle/package.json`
  Why: new bundle package metadata and local `codex-sdk-ts` dependency.
- `extensions/openai-chatgpt-apps-bundle/.codex-plugin/plugin.json`
  Why: Codex bundle discovery manifest.
- `extensions/openai-chatgpt-apps-bundle/.mcp.json`
  Why: declaration of the single stdio MCP bridge server.
- `extensions/openai-chatgpt-apps-bundle/src/server.ts`
  Why: stdio bridge entrypoint that will consume the shared-state contract.
- `extensions/openai-chatgpt-apps-bundle/src/service-client.ts`
  Why: bundle-side control client that reads `control.json` and talks to the
  native service instead of reading snapshot files directly.
- `src/plugins/bundle-mcp.ts`
  Why: verify the chosen bundle structure matches current loading behavior;
  should not be modified in this milestone.
- `src/agents/embedded-pi-mcp.ts`
  Why: verify that top-level `mcp.servers` still overrides bundle defaults;
  should not be modified in this milestone.

### Resolved Ambiguities / Decisions

- Bundle placement: the ChatGPT apps bundle will live in its own
  `extensions/openai-chatgpt-apps-bundle/` package, not in `extensions/openai/`.
- Service startup: `start(...)` creates shared-state metadata only and defers
  sidecar startup until a later bridge request.
- Shared state: both the native service and bundle will use one namespaced root
  under `${STATE_DIR}/plugin-runtimes/openai-chatgpt-apps/`.
- Snapshot ownership: the service will be the only component that reads or
  writes persisted snapshot files; the bridge will use the control endpoint.
- Failure behavior: missing or invalid control metadata will be surfaced as
  bundle diagnostics plus an empty app toolset, not as implicit fallback logic.
- Dependency strategy: the bundle will use a local `file:` dependency on
  `/Users/kevinlin/code/codex-sdk-ts` for now.

### Important Implementation Notes

- Milestone 1 should not introduce placeholder runtime hooks that imply core
  changes later. If a seam cannot be expressed with current plugin surfaces,
  the spec should not pretend otherwise.
- The service should remain safe even when `chatgptApps.enabled = true` and the
  bundle is not installed.
- The bundle entrypoint can contain scaffold behavior, but it should already
  honor the control metadata file path contract rather than inventing a second
  discovery path.
- The service must be safe in two startup states:
  - `chatgptApps.enabled = true` and bundle installed
  - `chatgptApps.enabled = true` and bundle absent
    In both cases, `start(...)` must remain lightweight and non-failing.

---

## Acceptance Criteria

- [ ] A separate bundle package exists for ChatGPT apps and is structurally
      discoverable as a Codex bundle rather than a native plugin.
- [ ] The native `openai` plugin registers a ChatGPT apps service using the
      existing `registerService(...)` SDK surface and does not require any
      runtime/core changes under `src/`.
- [ ] The service and bundle share one explicit, documented state and control
      contract, including deterministic path helpers and typed control payloads.
- [ ] Enabling `plugins.entries.openai.config.chatgptApps.enabled` starts only a
      lightweight native service and does not eagerly spawn `codex app-server`.
- [ ] The `openai` plugin config schema contains the `chatgptApps` settings
      needed by later milestones.
- [ ] The bundle bridge is wired to consume `control.json` first and surfaces
      missing or invalid control metadata through diagnostics plus an empty app
      toolset instead of fallback process spawning.

---

## Phases and Dependencies

### Phase 1: Package and Schema Scaffolding

- [ ] Create `extensions/openai-chatgpt-apps-bundle/`.
- [ ] Add bundle `package.json`, `.codex-plugin/plugin.json`, and `.mcp.json`.
- [ ] Add `chatgptApps` config schema to `extensions/openai/openclaw.plugin.json`.
- [ ] Add the local `file:/Users/kevinlin/code/codex-sdk-ts` dependency to the
      bundle package.

### Phase 2: Native Service Registration and Shared-State Contract

- [ ] Add ChatGPT apps service registration in `extensions/openai/index.ts`.
- [ ] Add `state-paths.ts` with deterministic namespaced path helpers.
- [ ] Add `control-protocol.ts` with typed request and response contracts.
- [ ] Add a lightweight `service.ts` skeleton that creates the shared-state
      directory and `control.json` but does not yet do full refresh work.
- [ ] Define the initial `health/read`, `snapshot/read`, and `snapshot/refresh`
      response shapes, including how "not ready yet" is represented.

### Phase 3: Bundle Bootstrap Wiring

- [ ] Add `src/server.ts` and `src/service-client.ts` scaffolding that consumes
      the shared-state contract.
- [ ] Ensure the bridge entrypoint expects the native service to own snapshot
      files and control metadata.
- [ ] Ensure the bridge returns diagnostics plus an empty app toolset when
      control metadata is missing or invalid.
- [ ] Add tests that prove package detection and lightweight service startup.

### Phase Dependencies

- Phase 2 depends on Phase 1 because the service contract depends on the
  config schema and bundle package being named and rooted correctly.
- Phase 3 depends on Phase 2 because the bundle must consume the finalized
  shared-state contract rather than redefining it locally.
- Milestone 2 depends on this milestone establishing stable service and bundle
  ownership boundaries.

---

## Validation Plan

Integration tests:

- Verify the new `extensions/openai-chatgpt-apps-bundle/` package is loaded as
  a Codex bundle and contributes exactly one stdio MCP server.
- Verify enabling `chatgptApps` registers the native service without modifying
  or extending OpenClaw runtime service behavior.
- Verify top-level `mcp.servers` still overrides bundle defaults with the new
  bundle installed.
- Verify the bridge startup path returns diagnostics and no app tools when
  `control.json` is missing or malformed.

Unit tests:

- Validate shared-state path helpers produce one stable namespaced root for the
  native service and bundle.
- Validate control protocol serialization and metadata file shape.
- Validate the lightweight service startup path does not attempt to spawn
  `codex app-server`.
- Validate service startup remains non-failing when `chatgptApps.enabled = true`
  but the bundle is not installed.

Manual validation:

- Install dependencies for the new bundle package locally and confirm the
  package is discoverable as bundle format `codex`.
- Enable `plugins.entries.openai.config.chatgptApps.enabled` and confirm the
  service starts without connector refresh or sidecar spawn.
- Inspect the namespaced shared-state directory and confirm `control.json`
  exists with the expected shape.
- Temporarily remove or invalidate `control.json` and confirm the bridge emits
  diagnostics rather than trying to start its own fallback process.

---

## Done Criteria

- [ ] Milestone 1 implementation is complete and matches the acceptance
      criteria.
- [ ] Validation results are run or explicitly recorded with any follow-up work
      captured for Milestones 2 and 3.
- [ ] The design doc and Milestone 1 spec remain aligned on service ownership,
      bundle ownership, and shared-state contracts.

---

## Open Items and Risks

### Open Items

- [ ] Decide whether the bundle server name should be `openai-chatgpt-apps` or
      another stable id before implementation starts.
- [ ] Confirm whether the bundle package should be added to any existing docs
      indices or plugin catalogs in the same implementation PR.

### Risks and Mitigations

| Risk                                                                                            | Impact | Probability | Mitigation                                                                                                          |
| ----------------------------------------------------------------------------------------------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Bundle placement accidentally collides with native plugin detection rules                       | High   | Med         | Keep the bundle in a separate package root and validate bundle detection explicitly in tests                        |
| Service and bundle choose different shared-state paths                                          | High   | Med         | Centralize path computation in one `state-paths.ts` module used by both sides                                       |
| Lightweight service startup still performs hidden work at gateway boot                          | Med    | Med         | Add tests around `start(...)` behavior and keep sidecar launch out of Milestone 1 code paths                        |
| The service and bridge disagree on how "not ready yet" is represented over the control protocol | High   | Med         | Define the control response shape in this milestone and add serialization tests before refresh logic is implemented |
| The local `file:` SDK dependency breaks installs on machines without the local repo             | Med    | High        | Treat it as local-only for this milestone and document the constraint in the spec and package metadata              |

### Simplifications and Assumptions

- Milestone 1 may use thin scaffolding or stubs for later refresh and execution
  flows as long as the ownership boundaries and file contracts are final.
- Validation for this milestone does not require live ChatGPT auth or live
  connector inventory.

---

## Outputs

- PR created from this spec: Not started

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-28: Created the Milestone 1 feature spec for the ChatGPT apps native service and bundle skeleton. (019d37da-b9a9-72b1-9bda-231d842ceb58 - (2638b566f1694da1a8248efc99f7fc94fbb59b94))
