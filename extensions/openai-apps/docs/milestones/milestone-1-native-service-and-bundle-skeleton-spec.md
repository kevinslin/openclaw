# Feature Spec: Milestone 1 - Bundle Skeleton and Bundle-Owned State Contract

**Date:** 2026-03-28
**Status:** Planning

---

## Goal and Scope

### Goal

Land the minimum plugin-only structure needed to expose ChatGPT apps through a
separate Codex bundle while keeping all runtime ownership inside the bundle MCP
subprocess. Milestone 1 should establish the package layout, bundle-owned state
contract, config schema, and bridge bootstrap behavior without yet requiring
full connector refresh or remote tool execution.

### In Scope

- Add a separate bundle package root for ChatGPT apps under `extensions/`.
- Define the bundle-owned runtime cache layout under `OPENCLAW_STATE_DIR`.
- Extend `extensions/openai/openclaw.plugin.json` with the `chatgptApps`
  config schema needed by later milestones.
- Add the local `file:/Users/kevinlin/code/codex-sdk-ts` dependency in the new
  bundle package for local development.
- Add bundle bridge scaffolding that loads config, resolves state paths, and
  prepares for later on-demand refresh behavior.

### Out of Scope

- Full `app/list` pagination and persisted connector snapshot refresh logic.
- Remote ChatGPT apps MCP `tools/call` execution.
- End-to-end connector publication through real app inventory.
- Any OpenClaw runtime changes under `src/` beyond consuming existing bundle
  loading and exported plugin-sdk surfaces.
- Any native `registerService(...)` or service-to-bundle control contract.
- CI- or marketplace-ready replacement for the local `file:` SDK dependency.

---

## Context and Constraints

### Background

The updated design in `docs/specs/2026-03-chatgpt-apps/design.md` intentionally
backs away from the earlier service-plus-bundle split. The approved direction
keeps the useful app-server and auth-projection logic, but it requires all new
runtime ownership to stay inside the bundle MCP subprocess. Milestone 1 is the
enabling step that creates that bundle-only seam without taking dependency on
connector refresh behavior being finished yet.

### Current State

- `extensions/openai/openclaw.plugin.json` has no ChatGPT apps config schema.
- Bundle MCP support already exists via `.codex-plugin/plugin.json` and
  `.mcp.json`, merged into embedded Pi config by existing bundle loading code.
- There is no need for a native service in this design, so
  `extensions/openai/index.ts` should remain untouched for ChatGPT apps
  lifecycle concerns.
- Bundle subprocesses inherit normal OpenClaw env such as `OPENCLAW_STATE_DIR`,
  which can be used to derive deterministic plugin-owned cache paths without
  runtime changes.
- There is no plugin-specific service state root or control socket to define in
  this architecture.

### Required Pre-Read

- `docs/specs/2026-03-chatgpt-apps/design.md`
- `extensions/openai/openclaw.plugin.json`
- `src/plugins/bundle-mcp.ts`
- `src/agents/embedded-pi-mcp.ts`
- `docs/plugins/bundles.md`

### Constraints

- Only plugin code should change. No new runtime primitives in `src/`.
- The native `openai` package cannot also be the bundle root because native
  manifests win over `.codex-plugin/plugin.json`.
- Milestone 1 must not reintroduce `registerService(...)` or any bundle-to-
  service control channel.
- The bundle must own one deterministic runtime cache root under
  `OPENCLAW_STATE_DIR/plugin-runtimes/openai-chatgpt-apps/`.
- `file:/Users/kevinlin/code/codex-sdk-ts` is acceptable for local work but not
  portable to CI or broader distribution.

### Non-obvious Dependencies or Access

- Local access to `/Users/kevinlin/code/codex-sdk-ts` is required to install the
  new bundle package as designed.
- Later milestones depend on valid `openai-codex` OAuth state, but Milestone 1
  should not require live auth to validate package wiring and bridge startup.

---

## Approach and Touchpoints

### Proposed Approach

Create a new bundle package under `extensions/openai-chatgpt-apps-bundle/` that
declares exactly one stdio MCP server and contains the future bridge entrypoint.
At the same time, extend the native `openai` plugin config schema so the bundle
can read `plugins.entries.openai.config.chatgptApps`. The bundle owns its own
runtime cache layout under `OPENCLAW_STATE_DIR`, but Milestone 1 stops short of
real app-server refresh work.

Milestone 1 must produce these concrete artifacts and invocation contracts:

- the bundle package exists and is discoverable as Codex bundle format
- `state-paths.ts` resolves
  `${OPENCLAW_STATE_DIR}/plugin-runtimes/openai-chatgpt-apps/`
- `server.ts` loads config and bundle-owned state paths before instantiating the
  bridge
- the bridge returns no app tools when the feature is disabled or when no
  publishable snapshot exists yet
- there is no native service registration, control metadata file, or bundle-
  to-service IPC dependency

### Integration Points / Touchpoints

- `docs/specs/2026-03-chatgpt-apps/design.md`
  Why: source of truth for the bundle-owned architecture and milestone scope.
- `extensions/openai/openclaw.plugin.json`
  Why: host schema for `plugins.entries.openai.config.chatgptApps`.
- `extensions/openai-chatgpt-apps-bundle/package.json`
  Why: new bundle package metadata and local `codex-sdk-ts` dependency.
- `extensions/openai-chatgpt-apps-bundle/.codex-plugin/plugin.json`
  Why: Codex bundle discovery manifest.
- `extensions/openai-chatgpt-apps-bundle/.mcp.json`
  Why: declaration of the single stdio MCP bridge server.
- `extensions/openai-chatgpt-apps-bundle/src/server.ts`
  Why: stdio bridge entrypoint that will own later refresh and execution flows.
- `extensions/openai-chatgpt-apps-bundle/src/config.ts`
  Why: bundle-side config normalization and feature gating.
- `extensions/openai-chatgpt-apps-bundle/src/state-paths.ts`
  Why: bundle-owned cache path helpers rooted under `OPENCLAW_STATE_DIR`.
- `extensions/openai-chatgpt-apps-bundle/src/mcp-bridge.ts`
  Why: bridge bootstrap and empty/diagnostic tool publication path.
- `src/plugins/bundle-mcp.ts`
  Why: verify the chosen bundle structure matches current loading behavior;
  should not be modified in this milestone.
- `src/agents/embedded-pi-mcp.ts`
  Why: verify that top-level `mcp.servers` still overrides bundle defaults;
  should not be modified in this milestone.

### Resolved Ambiguities / Decisions

- Bundle placement: the ChatGPT apps bundle will live in its own
  `extensions/openai-chatgpt-apps-bundle/` package, not in `extensions/openai/`.
- Runtime ownership: the bundle subprocess owns all future refresh behavior; no
  native service is introduced.
- State layout: the bundle will use one namespaced cache root under
  `${OPENCLAW_STATE_DIR}/plugin-runtimes/openai-chatgpt-apps/`.
- Snapshot bootstrap: Milestone 1 can operate with no snapshot present and
  publish an empty toolset plus diagnostics.
- Dependency strategy: the bundle will use a local `file:` dependency on
  `/Users/kevinlin/code/codex-sdk-ts` for now.

### Important Implementation Notes

- Milestone 1 should not introduce placeholder hooks that imply service-based
  runtime support later.
- The bridge must be safe when `chatgptApps.enabled = true` but no snapshot
  exists yet.
- The bridge may contain scaffold behavior, but it should already honor the
  bundle-owned state-path contract rather than inventing a second cache path.
- If `OPENCLAW_STATE_DIR` is missing, `state-paths.ts` should still derive the
  canonical OpenClaw state dir using existing state-resolution helpers instead
  of inventing a bundle-local fallback.

---

## Acceptance Criteria

- [ ] A separate bundle package exists for ChatGPT apps and is structurally
      discoverable as a Codex bundle rather than a native plugin.
- [ ] The native `openai` plugin config schema contains the `chatgptApps`
      settings needed by later milestones.
- [ ] The bundle owns one explicit, documented runtime cache contract rooted at
      `OPENCLAW_STATE_DIR/plugin-runtimes/openai-chatgpt-apps/`.
- [ ] No native `openai` service registration or service-control contract is
      added for ChatGPT apps.
- [ ] The bundle bridge loads config and state paths successfully and can return
      diagnostics plus an empty app toolset when no snapshot is available yet.
- [ ] No OpenClaw runtime/core changes under `src/` are required.

---

## Phases and Dependencies

### Phase 1: Package and Schema Scaffolding

- [ ] Create `extensions/openai-chatgpt-apps-bundle/`.
- [ ] Add bundle `package.json`, `.codex-plugin/plugin.json`, and `.mcp.json`.
- [ ] Add `chatgptApps` config schema to `extensions/openai/openclaw.plugin.json`.
- [ ] Add the local `file:/Users/kevinlin/code/codex-sdk-ts` dependency to the
      bundle package.

### Phase 2: Bundle-Owned State Contract

- [ ] Add `state-paths.ts` with deterministic namespaced path helpers.
- [ ] Define the initial snapshot/debug file names the bundle will own later.
- [ ] Add `config.ts` helpers that normalize feature gating and base config.
- [ ] Ensure the bridge can resolve the state root without relying on any new
      runtime API or service startup hook.

### Phase 3: Bridge Bootstrap Wiring

- [ ] Add `src/server.ts` and `src/mcp-bridge.ts` scaffolding.
- [ ] Ensure the bridge returns diagnostics plus an empty app toolset when the
      feature is disabled or no publishable snapshot exists.
- [ ] Add tests that prove bundle detection and bundle-owned state resolution.

### Phase Dependencies

- Phase 2 depends on Phase 1 because the state contract depends on the final
  bundle package root and config schema.
- Phase 3 depends on Phase 2 because the bridge should consume the finalized
  bundle-owned state contract rather than redefining it locally.
- Milestone 2 depends on this milestone establishing stable bundle ownership
  boundaries.

---

## Validation Plan

Integration tests:

- Verify the new `extensions/openai-chatgpt-apps-bundle/` package is loaded as
  a Codex bundle and contributes exactly one stdio MCP server.
- Verify top-level `mcp.servers` still overrides bundle defaults with the new
  bundle installed.
- Verify the bridge startup path returns diagnostics and no app tools when the
  feature is disabled or no snapshot is present.

Unit tests:

- Validate `state-paths.ts` produces one stable namespaced root under
  `OPENCLAW_STATE_DIR/plugin-runtimes/openai-chatgpt-apps/`.
- Validate config normalization and feature gating behavior.
- Validate the bridge bootstrap path does not attempt to require a native
  service or control socket.

Manual validation:

- Install dependencies for the new bundle package locally and confirm the
  package is discoverable as bundle format `codex`.
- Enable `plugins.entries.openai.config.chatgptApps.enabled` and confirm the
  bundle bridge starts without native service registration.
- Inspect the bundle-owned state root and confirm the expected directory layout
  can be created.
- Confirm the bridge returns no tools yet instead of failing when no snapshot
  has been created.

---

## Done Criteria

- [ ] Milestone 1 implementation is complete and matches the acceptance
      criteria.
- [ ] Validation results are run or explicitly recorded with any follow-up work
      captured for Milestones 2 and 3.
- [ ] The design doc and Milestone 1 spec remain aligned on bundle-only
      ownership and bundle-owned state contracts.

---

## Open Items and Risks

### Open Items

- [ ] Decide whether the bundle server name should be `openai-chatgpt-apps` or
      another stable id before implementation starts. - Answer: it should be`openai-chatgpt-apps`
- [ ] Confirm whether the bundle package should be added to any existing docs
      indices or plugin catalogs in the same implementation PR. - Answer: Add docs to docs/providers/openai.md

### Risks and Mitigations

| Risk                                                                                | Impact | Probability | Mitigation                                                                                             |
| ----------------------------------------------------------------------------------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------ |
| Bundle placement accidentally collides with native plugin detection rules           | High   | Med         | Keep the bundle in a separate package root and validate bundle detection explicitly in tests           |
| Bundle code derives a different state path across entrypoints                       | High   | Med         | Centralize path computation in one `state-paths.ts` module used by all bundle code                     |
| The bridge accidentally grows service-style assumptions back into the design        | Med    | Med         | Keep Milestone 1 free of service-client or control-protocol files and validate ownership in review     |
| The local `file:` SDK dependency breaks installs on machines without the local repo | Med    | High        | Treat it as local-only for this milestone and document the constraint in the spec and package metadata |

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

- 2026-03-28: Updated Milestone 1 to the bundle-only architecture by removing native service ownership and defining the bundle-owned runtime cache contract under `OPENCLAW_STATE_DIR`. (019d37da-b9a9-72b1-9bda-231d842ceb58 - (cc55b9534a))
- 2026-03-28: Created the Milestone 1 feature spec for the ChatGPT apps native service and bundle skeleton. (019d37da-b9a9-72b1-9bda-231d842ceb58 - (2638b566f1694da1a8248efc99f7fc94fbb59b94))
