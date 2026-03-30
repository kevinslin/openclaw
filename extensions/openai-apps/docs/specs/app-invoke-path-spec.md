# Feature Spec: App Invoke Path for OpenAI Apps

**Date:** 2026-03-29
**Status:** Planning

---

## Goal and Scope

### Goal

Add a new `plugins.entries.openai-apps.config.appInvokePath` setting so the
OpenAI apps bundle can choose between two execution backends:

- `appServer`
- `remoteMCP`

`appServer` becomes the default and routes every published app-tool invocation
through `codex app-server` using a fresh thread per invocation. `remoteMCP`
remains available as the fallback/debug path that preserves the current direct
remote `tools/call` behavior.

### In Scope

- Add `appInvokePath` to the `openai-apps` config contract with allowed values
  `appServer` and `remoteMCP`.
- Default `appInvokePath` to `appServer`.
- Introduce an invocation abstraction in the bundle so runtime execution can
  switch between app-server and remote-MCP backends without changing published
  local MCP tool names.
- Implement the `appServer` execution path using a dedicated fresh thread for
  every local MCP app-tool invocation.
- Keep `remoteMCP` as an explicit compatibility/debug mode.
- Update bundle docs and tests to reflect the new config and default behavior.

### Out of Scope

- Changes to OpenClaw core runtime under `src/`.
- Redesign of tool publication, connector snapshot caching, or connector
  enablement policy.
- Removal of `remote-codex-apps-client.ts`.
- Product UX changes outside the bundle, such as new operator UI for selecting
  invocation mode.
- Cross-thread reuse, pooling, or long-lived app-server invocation threads.

---

## Context and Constraints

### Background

The current bundle publishes ChatGPT app tools as local MCP tools and executes
them through the direct remote MCP path. The research in
`docs/research/2026-03-29-research-app-server-app-invocation-migration.md`
shows that app server already covers discovery, auth projection, app config,
and cached status refresh, but documented app execution is turn-driven rather
than direct tool RPC. The requested change is to support that turn-driven path
behind a bundle config mode, and to make it the default.

### Current State

- `extensions/openai-apps/src/config.ts` defines bundle config for enablement,
  `appServer`, `linking`, and `connectors`, but no invocation-mode switch.
- `extensions/openai-apps/src/mcp-bridge.ts` currently routes runtime
  `tools/call` through `remote-codex-apps-client.ts`.
- `extensions/openai-apps/src/app-server-session.ts` already spawns
  `codex app-server`, projects auth, writes derived app config, and captures
  `app/list` plus `legacy app-status RPC` for snapshot refresh.
- The research doc recommends an app-server-only prototype that resolves exact
  app ids from `app/list`, starts a fresh thread, invokes the app via
  `$<app-slug>` plus `mention { path: "app://<id>" }`, and converts the turn
  result back into the local MCP response shape.

### Required Pre-Read

- `docs/specs/2026-03-chatgpt-apps/design.md`
- `docs/research/2026-03-29-research-app-server-app-invocation-migration.md`
- `docs/specs/2026-03-chatgpt-apps/milestone-2-long-lived-app-server-and-cached-tool-publication-spec.md`
- `docs/specs/2026-03-chatgpt-apps/milestone-3-remote-tool-execution-and-hardening-spec.md`
- `extensions/openai-apps/src/config.ts`
- `extensions/openai-apps/src/mcp-bridge.ts`
- `extensions/openai-apps/src/app-server-session.ts`
- `extensions/openai-apps/src/remote-codex-apps-client.ts`
- `extensions/openai-apps/src/snapshot-cache.ts`

### Constraints

- `appInvokePath` must live entirely under
  `plugins.entries.openai-apps.config`.
- `appServer` is the default when the field is absent.
- Every `appServer` invocation must use a fresh thread; no app invocation may
  reuse a prior thread.
- The bundle must write app config before creating the invocation thread so the
  thread snapshot sees current enablement and approval settings.
- The bundle must continue to publish the same local MCP tool names regardless
  of invocation mode.
- `remoteMCP` must remain selectable for debugging, parity checks, and
  incremental rollout.
- No changes under `src/` are allowed.

### Non-obvious Dependencies or Access

- The chosen `codex-app-server-sdk` surface must expose enough thread/turn APIs
  to create a thread, start a turn, stream or inspect turn output, and close
  the client cleanly.
- Live validation depends on OpenClaw-owned `openai-codex` auth plus at least
  one accessible connector that works through app-server mention-driven
  invocation.

### Temporal Context Check

| State value            | Source of truth                         | Representation                 | Initialization point              | Snapshot/capture point                 | First consumer                       | Initialized before consumer snapshot? |
| ---------------------- | --------------------------------------- | ------------------------------ | --------------------------------- | -------------------------------------- | ------------------------------------ | ------------------------------------- |
| `appInvokePath`        | `plugins.entries.openai-apps.config`    | `"appServer"` or `"remoteMCP"` | bundle config load                | `mcp-bridge.ts` request handling       | invocation router                    | Yes                                   |
| Projected ChatGPT auth | OpenClaw OAuth store                    | access token + account id      | before app-server login           | per-invocation client setup            | thread creation / turn start         | Yes                                   |
| Derived app config     | bundle config projected into app server | `apps` config tree             | before invocation thread creation | thread-scoped config snapshot          | `app/list(threadId)` and turn gating | Must stay yes                         |
| App identity           | cached `app/list` snapshot              | exact `app.id` and app slug    | snapshot refresh                  | route reconstruction / invocation prep | app mention payload                  | Yes                                   |
| Invocation thread      | app server thread state                 | fresh `threadId`               | once per local tool call          | turn context snapshot                  | turn execution and approvals         | Yes                                   |

The critical ordering invariant is unchanged from the research brief: config
must be written before the new invocation thread is created.

---

## Approach and Touchpoints

### Proposed Approach

Add a bundle-owned invocation router that selects one of two backends:

- `remoteMCP`: current behavior, using the direct remote MCP client
- `appServer`: new behavior, using `codex app-server` turn orchestration

For `appServer`, the bridge should stop treating a local MCP tool call as a
remote app-tool RPC. Instead it should:

1. Resolve the target app from the persisted snapshot using exact app identity
   from `app/list`.
2. Spawn or connect an app-server client for this invocation only.
3. Project fresh auth and write derived app config.
4. Create a new disposable thread.
5. Start a turn that mentions the app via `app://<id>` and uses a deterministic
   prompt template that includes the rewritten local tool name and serialized
   JSON arguments.
6. Listen to turn events, approvals, and final output.
7. Convert the final turn result back into a local `CallToolResult`.

This keeps local publication stable while allowing execution semantics to shift
from direct remote tool RPC to app-server-managed turn orchestration.

### Integration Points / Touchpoints

- `extensions/openai-apps/src/config.ts`
  Why: add `appInvokePath` normalization, defaults, and config hashing.
- `extensions/openai-apps/src/mcp-bridge.ts`
  Why: route `tools/call` through the selected invocation backend.
- `extensions/openai-apps/src/app-server-session.ts`
  Why: existing app-server auth/config projection code should be reused or split
  into shared helpers for invocation.
- `extensions/openai-apps/src/remote-codex-apps-client.ts`
  Why: remains the `remoteMCP` backend.
- `extensions/openai-apps/src/snapshot-cache.ts`
  Why: app-server invocation must resolve exact app ids from persisted
  inventory, not only connector-name heuristics.
- `extensions/openai-apps/src/*.test.ts`
  Why: config, routing, and execution-mode coverage all change.
- `extensions/openai-apps/README.md`
  Why: configuration and default behavior documentation must change.
- `codex-app-server-sdk`
  Why: thread and turn orchestration APIs are the key external contract for the
  new default path.

### Resolved Ambiguities / Decisions

- Config location: `appInvokePath` belongs under
  `plugins.entries.openai-apps.config`.
- Allowed values: only `appServer` and `remoteMCP`.
- Default: absent or invalid values normalize to `appServer`.
- Default-behavior change: no backwards-compatibility hold is required for the
  old default execution path.
- Threading model: every `appServer` invocation uses a new disposable thread.
- Identity contract: app-server invocation must use exact `app.id` values from
  `app/list`; connector-name heuristics remain publication helpers only.
- Publication contract: the existing local MCP tool namespace stays unchanged.

### Important Implementation Notes

- The bundle should introduce an internal invocation-backend interface so the
  bridge is no longer hard-wired to the remote client.
- The `appServer` backend needs a deterministic prompt envelope so the same
  local MCP tool call produces stable app-server requests and test fixtures.
- Result extraction must distinguish between:
  - final successful app output
  - user-input / approval interruptions
  - app-server transport failure
  - "turn completed but no usable output" failure
- If `appServer` execution fails before a turn is started, the bundle should
  fail the local MCP tool call directly rather than silently falling back to
  `remoteMCP`.

---

## Acceptance Criteria

- [ ] `plugins.entries.openai-apps.config.appInvokePath` accepts only
      `appServer` and `remoteMCP`, and defaults to `appServer`.
- [ ] Published local MCP tool names do not change when switching invocation
      mode.
- [ ] When `appInvokePath=appServer`, each local MCP tool call executes through
      `codex app-server` on a fresh thread with current auth and current app
      config projected before thread creation.
- [ ] When `appInvokePath=remoteMCP`, the bundle preserves the current direct
      remote MCP execution path.
- [ ] The `appServer` path resolves target apps from `app/list` inventory using
      exact app ids rather than only connector-name heuristics.
- [ ] `appServer` execution surfaces approval interruptions, missing app route,
      missing output, and transport failures as explicit tool-call failures.

---

## Phases and Dependencies

### Phase 1: Config Contract and Invocation Routing

- [ ] Add `appInvokePath` to `ChatgptAppsConfig` normalization.
- [ ] Update config hashing and tests to include invocation mode.
- [ ] Introduce a bundle-owned invocation backend abstraction.
- [ ] Route `mcp-bridge.ts` `tools/call` through the selected backend.

### Phase 2: App-Server Invocation Backend

- [ ] Add an app-server invocation helper that creates a fresh client and fresh
      thread per local tool call.
- [ ] Reuse auth projection and derived app-config writes before thread
      creation.
- [ ] Resolve exact app id and app slug from persisted snapshot inventory.
- [ ] Start a turn with `$<app-slug>` plus `mention { path: "app://<id>" }`.
- [ ] Convert turn events and final output into `CallToolResult`.

### Phase 3: Hardening, Diagnostics, and Fallback Preservation

- [ ] Keep `remoteMCP` fully wired as the alternate invocation mode.
- [ ] Add diagnostics for selected invocation path, app-id resolution, and
      thread creation / turn failure points.
- [ ] Add regression coverage for missing app identity, no-output turns, and
      approval interruption behavior.
- [ ] Update docs to explain the new config field and the default path.

### Phase Dependencies

- Phase 2 depends on Phase 1 because the new backend must plug into a stable
  invocation router.
- Phase 3 depends on Phase 2 because the fallback, diagnostics, and failure
  coverage must validate the real app-server path.
- This work depends on the existing snapshot refresh path because app-server
  invocation needs exact `app/list` inventory data.

---

## Validation Plan

Integration tests:

- Verify config normalization defaults `appInvokePath` to `appServer`.
- Verify `appInvokePath=remoteMCP` still calls the remote client backend.
- Verify `appInvokePath=appServer` creates a new app-server thread for each
  local MCP tool call instead of reusing prior thread state.
- Verify the app-server path writes app config before thread creation.
- Verify the app-server path resolves exact `app.id` from persisted snapshot
  inventory and constructs the expected mention payload.
- Verify local MCP tool results are built from the final turn output and fail
  clearly when no usable output exists.

Unit tests:

- Validate config parsing for:
  - missing `appInvokePath`
  - `appInvokePath=appServer`
  - `appInvokePath=remoteMCP`
  - invalid value fallback to default
- Validate the deterministic invocation prompt builder for structured tool
  arguments.
- Validate route-to-app resolution prefers exact snapshot app identity over
  connector-name heuristics.

Manual validation:

- Run a live Gmail invocation with default config and verify the bundle uses the
  app-server path.
- Run the same invocation with `appInvokePath=remoteMCP` and verify the bundle
  uses the legacy remote path.
- Verify repeated app invocations create separate threads and do not leak prior
  turn context.
- Verify at least one connector that requires approval behaves acceptably
  through the `appServer` path.

---

## Done Criteria

- [ ] The bundle supports both invocation modes and defaults to `appServer`.
- [ ] Automated validation covers config normalization, backend selection, and
      core app-server invocation behavior.
- [ ] Bundle docs and planning docs are updated to describe the new default and
      the fallback path.

---

## Open Items and Risks

### Open Items

- [ ] Confirm the exact `codex-app-server-sdk` thread/turn APIs that will be
      used for the new backend and whether an SDK bump is required.
- [ ] Decide the final deterministic prompt template for mapping structured MCP
      args into app-server turn input.

### Risks and Mitigations

| Risk                                                                                           | Impact | Probability | Mitigation                                                                                           |
| ---------------------------------------------------------------------------------------------- | ------ | ----------- | ---------------------------------------------------------------------------------------------------- |
| App-server turn output cannot be mapped cleanly back into `CallToolResult` for some connectors | High   | Med         | Prototype result extraction early and keep `remoteMCP` as an explicit fallback mode                  |
| Approval behavior in turn-driven execution diverges from current MCP expectations              | High   | Med         | Add live/manual validation for approval-heavy connectors before removing any fallback                |
| Fresh-thread-per-call execution adds unacceptable latency                                      | Med    | Med         | Measure live latency during rollout and keep `remoteMCP` available for comparison                    |
| App identity from `app/list` does not map cleanly to existing local route metadata             | Med    | Med         | Persist exact app ids in route metadata and stop relying on connector-name heuristics for invocation |
| Config is written after thread creation, causing stale enablement or approval snapshots        | High   | Low         | Centralize app-server invocation setup so config write always happens before thread creation         |

### Simplifications and Assumptions

- This spec assumes the bundle will continue publishing local MCP tools from the
  existing snapshot/status flow and is only changing runtime execution.
- This spec assumes per-invocation disposable threads are acceptable even if a
  later optimization introduces pooling.

---

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-29: Created feature spec for dual invocation-path support with default app-server execution (019d3bf7-c7ad-74f3-94e8-3d5b6a50651c - (f8f59765d6))
