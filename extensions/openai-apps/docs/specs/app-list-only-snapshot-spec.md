# Feature Spec: OpenAI Apps App-List-Only Snapshot And Publication

**Date:** 2026-03-29
**Status:** Implemented

---

## Goal and Scope

### Goal

Remove `legacy app-status RPC` from the `openai-apps` bundle and make `app/list`
the only external source of truth, with the persisted snapshot storing one
canonical connector-level record per published app for publication and runtime
route reconstruction.

### In Scope

- Stop calling `legacy app-status RPC` during snapshot refresh.
- Replace the persisted `statuses` snapshot field with a single connector-level
  snapshot structure derived from `app/list`.
- Make `tools/list` publish solely from connector records derived from
  `app/list`.
- Remove cache-key, validation, and description logic that still depends on
  `McpServerStatus.tools`.
- Update docs and tests to describe and enforce the app-list-only model.

### Out of Scope

- Any change under repo-root `src/`.
- Changes to the upstream app-server protocol.
- Reintroducing remote MCP fallback or any dual-source publication model.
- Adding connector capabilities back through another status-like endpoint.

---

## Context and Constraints

### Background

The bundle has already moved to a connector-level tool namespace,
`chatgpt_app_<connectorId>`, and app invocation now uses app-server threads plus
`$<app-slug>` mention input. That means the old reason for reading
`legacy app-status RPC` has mostly disappeared: we no longer publish one tool per
remote MCP tool, and we no longer need remote-tool-name routing for top-level
execution.

Despite that, the current bundle still persists and consumes status data during
refresh. That keeps an unnecessary dependency on app-server MCP status
pagination and adds a hard-failure condition that is not fundamental to the new
connector-level design.

### Prior State

Before this migration landed, refresh read both `app/list` and the legacy
status RPC, persisted raw inventory/status arrays, and carried extra route and
description logic tied to remote tool metadata. The implemented change removes
that model entirely and leaves `app/list` as the only external refresh source.

### Required Pre-Read

- `docs/specs/2026-03-chatgpt-apps/app-server-only-publication-spec.md`
- `docs/flows/ref.openai-apps-list-tools.md`
- `docs/flows/ref.openai-apps-call-tool.md`
- `extensions/openai-apps/src/app-server-session.ts`
- `extensions/openai-apps/src/snapshot-cache.ts`
- `extensions/openai-apps/src/mcp-bridge.ts`
- `extensions/openai-apps/src/app-server-invoker.ts`

### Constraints

- No work under repo-root `src/`.
- No backwards compatibility is required for the old snapshot shape or old
  config assumptions.
- The resulting publication model must remain connector-level:
  `chatgpt_app_<connectorId>`.
- Runtime app invocation must keep using fresh threads plus `$<app-slug>` and
  `app://<appId>` mention input.
- The persisted snapshot must still be sufficient to rebuild routes and publish
  tools without any live status or inventory lookups.

### Non-obvious Dependencies or Access

- Live validation still depends on a working `codex` app-server binary and valid
  `openai-codex` OAuth projection.
- This change assumes `AppInfo` from `app/list` exposes stable enough data for:
  exact app id, accessibility/enablement, description text, and name-based slug
  derivation.

### Temporal Context Triage

| Value / Flag                     | Source of truth                              | Representation                     | Initialization point                       | Snapshot / capture point       | First consumer                            | Initialized before capture? |
| -------------------------------- | -------------------------------------------- | ---------------------------------- | ------------------------------------------ | ------------------------------ | ----------------------------------------- | --------------------------- |
| App inventory                    | app-server `app/list`                        | `AppInfo[]`                        | refresh session after login + config write | `captureAppServerSnapshot()`   | connector snapshot derivation             | Yes                         |
| Connector snapshot record        | bundle-derived from `AppInfo`                | one persisted connector object     | during snapshot derivation                 | before snapshot write          | publication and invocation route lookup   | Yes                         |
| App invocation token             | bundle-derived from `AppInfo`                | normalized slug string             | during snapshot derivation                 | embedded in connector snapshot | `buildInvocationInput()`                  | Yes                         |
| Published tool name              | bundle-derived from connector id             | `chatgpt_app_<connectorId>`        | during snapshot derivation                 | embedded in connector snapshot | `listTools()` / `callTool()` route lookup | Yes                         |
| App accessibility and enablement | `AppInfo.isAccessible` / `AppInfo.isEnabled` | booleans                           | returned by `app/list`                     | embedded in connector snapshot | publication gating                        | Yes                         |
| Tool capability count            | legacy status RPC                            | number derived from `status.tools` | refresh session                            | snapshot write                 | tool description text only                | Historical only             |

The ordering problem is favorable here: every persisted value needed for
connector-level publication can be derived before the snapshot is written, using
only `app/list` output plus bundle normalization rules.

---

## Approach and Touchpoints

### Proposed Approach

Replace the current two-part snapshot (`inventory` + `statuses`) with a single
connector-level snapshot derived immediately from `app/list`.

Under the target design:

- refresh calls only `app/list`
- snapshot persistence stores only connector-level records derived from
  `app/list`
- `tools/list` rebuilds directly from that metadata
- `tools/call` resolves routes directly from that metadata
- capability-count text and status-based completeness checks disappear

This keeps `app/list` as the only external source of truth while ensuring the
persisted snapshot itself is the single runtime contract.

The persisted `connectors[]` list should contain all discovered connectors from
`app/list`, not only publishable ones. Publication should still gate on the
persisted `isAccessible` and `isEnabled` fields at read time. That preserves
debug visibility into "present but inaccessible/disabled" apps while still
keeping one canonical structure.

### Integration Points / Touchpoints

- `extensions/openai-apps/src/app-server-session.ts`
  Why: stop calling `legacy status listing helper()` and return app-list-only capture
  data.
- `extensions/openai-apps/src/snapshot-cache.ts`
  Why: redefine the persisted snapshot type and cache-key inputs around one
  canonical connector-level record shape.
- `extensions/openai-apps/src/refresh-snapshot.ts`
  Why: persist the new snapshot shape and remove `statuses` plumbing.
- `extensions/openai-apps/src/mcp-bridge.ts`
  Why: publish tools and rebuild routes from snapshot connector metadata instead
  of status regrouping.
- `extensions/openai-apps/src/app-server-invoker.ts`
  Why: remove stale route baggage left over from the pre-migration model.
- `extensions/openai-apps/src/*.test.ts`
  Why: replace status-based expectations with app-list-only expectations.
- `extensions/openai-apps/README.md`
  Why: update the documented cache snapshot example and remove status-based
  language.
- `docs/flows/ref.openai-apps-list-tools.md`
  Why: refresh no longer reads `legacy app-status RPC`.
- `docs/flows/ref.openai-apps-call-tool.md`
  Why: runtime route reconstruction should point at snapshot connector metadata,
  not status-derived route state.

### Resolved Ambiguities / Decisions

- External source of truth: `app/list` is the only external endpoint used for
  refresh.
- Snapshot design: persist one canonical connector-level record and do not keep
  a second raw `inventory` copy in the snapshot.
- Snapshot membership: `connectors[]` stores all discovered connectors from
  `app/list`, not only publishable connectors. Publication re-applies gating
  from persisted `isAccessible` and `isEnabled`.
- Canonical connector id derivation:
  - prefer normalized non-opaque `app.id`
  - otherwise use normalized `app.name`
  - otherwise use the first normalized `pluginDisplayNames` entry
  - if two apps still collapse to the same base connector id, assign the
    unsuffixed base id to the lexicographically smallest `app.id` in that
    collision group and suffix all others with a stable fragment derived from
    `app.id`
- Alias handling: `pluginDisplayNames` may be persisted for debugging and future
  explainability, but they do not create alternate published routes. Each app
  yields exactly one canonical connector record.
- Tool descriptions: remove capability-count text derived from remote status
  tools. Published descriptions should use:
  - `AppInfo.description` when present
  - otherwise `Use ${appName} through ChatGPT apps.`
  - no capability-count suffix
- Validation model: publication completeness is defined by app-list-derived
  connector metadata, not by separate status coverage.
- Runtime routing: top-level invocation does not need remote tool names, and
  the pre-migration route baggage has been removed.
- Malformed snapshot behavior: malformed or incomplete connector records are a
  hard publication failure, not a degraded path or best-effort skip.

### Connector Record Contract

Each persisted connector record is the canonical runtime contract for one app.
Required fields:

- `connectorId`
  - derived
  - canonical normalized connector key used for publication and routing
- `appId`
  - copied from `AppInfo.id`
  - exact app id used in `app://<appId>` mention paths
- `appName`
  - copied from `AppInfo.name` when present, otherwise first display-name
    fallback chosen by the bundle
- `pluginDisplayNames`
  - copied from `AppInfo.pluginDisplayNames`
  - retained for explainability/debugging only
- `description`
  - copied from `AppInfo.description` when present, otherwise bundle-derived
    fallback text
- `isAccessible`
  - copied from `AppInfo.isAccessible`
  - used for publication gating
- `isEnabled`
  - copied from `AppInfo.isEnabled`
  - used for publication gating
- `publishedName`
  - derived
  - always `chatgpt_app_<connectorId>`
- `appInvocationToken`
  - derived
  - normalized slug inserted into `$<app-slug>` text input during invocation

Optional fields should be avoided unless implementation proves they are needed
to preserve runtime behavior.

### Important Implementation Notes

- The new persisted snapshot should explicitly encode one canonical connector
  record per discovered app. A concrete target shape is:

```json
{
  "version": 2,
  "fetchedAt": "...",
  "projectedAt": "...",
  "accountId": "...",
  "authIdentityKey": "...",
  "connectors": [
    {
      "connectorId": "gmail",
      "appId": "asdk_app_...",
      "appName": "Gmail",
      "publishedName": "chatgpt_app_gmail",
      "appInvocationToken": "gmail",
      "description": "...",
      "pluginDisplayNames": ["Gmail"],
      "isAccessible": true,
      "isEnabled": true
    }
  ]
}
```

- `connectors[]` should be derived during refresh, not lazily during every
  publication call. That makes the snapshot itself the full publication and
  invocation contract.
- Snapshot derivation should fail during refresh if:
  - no canonical connector id can be derived for an app
  - two apps still collide after deterministic suffixing
- Snapshot version should be bumped because the shape changes materially and old
  snapshots should be invalidated cleanly.
- The cache key should hash only fields that affect connector-level publication
  or invocation. It should not depend on removed `status.tools` names.

---

## Acceptance Criteria

- [x] `openai-apps` no longer calls app-server `legacy app-status RPC` during
      refresh.
- [x] The persisted snapshot no longer stores `statuses` and instead stores
      one canonical connector-level record set derived from `app/list` to
      rebuild publication and
      invocation routes.
- [x] `tools/list` publishes connector-level tools using only persisted
      connector records from the snapshot.
- [x] `tools/call` resolves routes using the app-list-derived snapshot metadata,
      without relying on `McpServerStatus.tools` or remote tool names.
- [x] Published tool descriptions no longer include capability-count text from
      `status.tools`.
- [x] Duplicate opaque-app collisions are resolved deterministically with
      stable suffixes derived from `app.id`, without depending on `app/list`
      order.
- [x] Malformed or incomplete connector records fail publication instead of
      degrading or being skipped silently.
- [x] Snapshot freshness and cache-key logic no longer depend on
      `legacy app-status RPC` output.
- [x] The initialization/cache flow and README snapshot example both describe an
      app-list-only snapshot model.

---

## Phases and Dependencies

### Phase 1: Redefine the snapshot contract

- [x] Add a new snapshot version that removes `statuses`.
- [x] Define persisted `connectors[]` metadata derived from `AppInfo`.
- [x] Encode canonical connector-id derivation and deterministic collision
      handling in the snapshot builder.
- [x] Update snapshot read/write and cache-key logic to use the new shape.

### Phase 2: Remove status collection from refresh

- [x] Delete `legacy status refresh helper()` from the refresh path.
- [x] Make `captureAppServerSnapshot()` read only paginated `app/list`.
- [x] Update refresh tests to assert app-list-only capture behavior.

### Phase 3: Rebuild publication from app-list-derived metadata

- [x] Replace status regrouping and status completeness checks with
      snapshot `connectors[]` reads.
- [x] Remove capability-count description logic.
- [x] Remove stale pre-migration route fields that no longer have a runtime
      consumer.

### Phase 4: Docs and proof updates

- [x] Update flow docs and README snapshot examples.
- [x] Re-run live connector proof to confirm Gmail and list-tools still
      publish and invoke correctly, with the remaining live timeout isolated to
      the Linear leg of the full harness.

### Phase Dependencies

- Phase 1 must come first because Phases 2 and 3 depend on the new snapshot
  contract.
- Phase 3 depends on the new snapshot being written during refresh.
- Phase 4 depends on the new behavior being implemented and validated.

---

## Validation Plan

Integration tests:

- Add or update a snapshot refresh test proving only `app/list` is requested
  during refresh.
- Add or update bridge tests proving connector-level publication succeeds from a
  snapshot with only `connectors[]` and no `statuses`.
- Add or update call-path tests proving `chatgpt_app_<connectorId>` invocation
  succeeds with routes reconstructed from the new snapshot metadata.

Unit tests:

- Add coverage for connector metadata derivation from `AppInfo`:
  connector id normalization, published tool name, invocation token, and
  description fallback.
- Add coverage for duplicate canonical connector-id derivation staying stable
  across `app/list` order.
- Add coverage for old snapshot version invalidation.
- Add coverage for snapshot key changes after connector-level publication fields
  change, without any status dependency.

Manual validation:

- Run the dev gateway / dev tui flow and verify `list all tools` still shows the
  connector-level namespace.
- Verify a Gmail request, a Google Calendar request, and a Linear request still
  execute end to end through app-server.
- Inspect the persisted snapshot and confirm it contains `connectors[]` and no
  `inventory` or `statuses`.
- Verify inaccessible or disabled connectors remain visible in the snapshot but
  are not published as MCP tools.

### Separate Validation Spec (Optional)

- None planned; scoped tests plus live connector proof should be sufficient.

---

## Done Criteria

- [x] Implementation matches the app-list-only snapshot model in this spec.
- [x] Validation results are recorded or linked, including the current live
      connector proof status.
- [x] Flow docs, README, and spec docs are updated to remove status-based
      publication language from the current-state documentation.

---

## Open Items and Risks

### Open Items

- [ ] The remaining live Linear timeout in the full integration harness is still
      unresolved and blocks the Google Calendar leg in `full` mode.

### Risks and Mitigations

| Risk                                                                                               | Impact | Probability | Mitigation                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppInfo` lacks some field we implicitly depended on from status metadata                          | Med    | Low         | Encode the exact required fields in the new `connectors[]` snapshot contract and prove route rebuild plus publication from tests before removing status code. |
| Snapshot migration leaves stale v1 files around and causes confusing publication failures          | Med    | Med         | Bump snapshot version, invalidate old snapshots cleanly, and add tests that v1 snapshots are treated as stale.                                                |
| Removing status-based capability text makes tool descriptions less informative                     | Low    | Med         | Use `AppInfo.description` when present and a connector-level fallback otherwise; do not block the migration on capability counts.                             |
| Two apps resolve to the same canonical connector id and published names depend on `app/list` order | High   | Med         | Assign connector ids deterministically within each collision group and cover the behavior with order-invariance tests.                                        |
| Hidden status-dependent code remains in tests or route types                                       | Med    | Med         | Search for status-model remnants in runtime docs/specs and remove or explicitly mark them as historical context.                                              |

### Simplifications and Assumptions

- This spec assumes connector-level publication is now the stable contract, so
  there is no need to preserve per-remote-tool metadata in the bundle snapshot.

---

## Outputs

- PR created from this spec: Not yet

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-29: Incorporated review feedback by defining `connectors[]` membership, canonical connector-id derivation, the connector record contract, hard-failure behavior for malformed records, and expanded validation coverage. (019d3cd6-184f-7e53-b6ff-189c1cff7a9a - (49b9a10a20))
- 2026-03-29: Revised the spec to use one canonical persisted `connectors[]` snapshot structure instead of persisting both raw `inventory` and derived connector metadata. (019d3cd6-184f-7e53-b6ff-189c1cff7a9a - (49b9a10a20))
- 2026-03-29: Created the feature spec for removing `legacy app-status RPC` and moving `openai-apps` to an app-list-only snapshot contract. (019d3cd6-184f-7e53-b6ff-189c1cff7a9a - (49b9a10a20))
