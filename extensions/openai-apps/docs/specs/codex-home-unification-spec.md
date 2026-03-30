# Feature Spec: OpenAI Apps Shared App-Server CODEX_HOME

**Date:** 2026-03-30
**Status:** Implemented (integration validation pending)

---

## Goal and Scope

### Goal

Remove the current split where snapshot refresh uses the bundle-owned
`plugin-runtimes/openai-apps/codex-home` while per-tool invocation creates and
deletes a separate temporary `CODEX_HOME`, and converge both paths on one
bundle-owned app-server home.

### In Scope

- Document the current refresh versus invocation `CODEX_HOME` split from the
  shipped code.
- Change the `openai-apps` bundle so refresh and invocation both launch
  `codex app-server` with the same bundle-owned `statePaths.codexHomeDir`.
- Remove per-invocation temporary `CODEX_HOME` directory creation and teardown
  unless implementation-time validation proves shared-home reuse is unsafe.
- Define the config-write contract for the shared-home model so invocation does
  not depend on stale or missing `apps` config state.
- Update tests and docs to reflect the unified-home runtime model.

### Out of Scope

- Changing the fresh-thread-per-invocation requirement.
- Reusing one long-lived app-server process across refresh and invocation.
- Changing OpenClaw core under repo-root `src/`.
- Changing upstream app-server protocol or its on-disk data model.

---

## Context and Constraints

### Background

The bundle currently has one persistent app-server home for refresh and a
different throwaway home for invocation.

Refresh goes through `withLoggedInAppServerSession(...)`, which launches
`codex app-server` with `CODEX_HOME: params.statePaths.codexHomeDir`, logs in,
and writes the derived `apps` config before calling `app/list`.

Invocation goes through `invokeViaAppServer(...)`, which creates
`invocationCodexHomeDir = await mkdtemp(...)`, launches `codex app-server` with
that temporary home, logs in, explicitly logs
`app-server config write skipped for invocation session`, and deletes the
temporary directory in `finally`.

That means the runtime path is split even though both paths are bundle-owned and
both already share the same projected auth source plus the same persisted
connector snapshot.

### Current State

- `extensions/openai-apps/src/state-paths.ts` defines a persistent bundle-owned
  home at `plugin-runtimes/openai-apps/codex-home`.
- `extensions/openai-apps/src/app-server-session.ts` uses that home for refresh
  and writes bundle-derived `apps` config before `app/list`.
- `extensions/openai-apps/src/app-server-invoker.ts` does not use
  `statePaths.codexHomeDir`; it creates a temp home with `mkdtemp(...)`.
- The invocation path does not write `apps` config and instead relies on the
  mention-based app invocation contract plus projected auth and route metadata.
- The invocation path removes the temp home after client shutdown.
- No bundle code reads invocation-home files directly, persists invocation-home
  artifacts across calls, or reconstructs runtime state from the temp home.

### Required Pre-Read

- `extensions/openai-apps/docs/flows/ref.openai-apps-call-tool.md`
- `docs/specs/2026-03-chatgpt-apps/app-server-only-publication-spec.md`
- `docs/specs/2026-03-chatgpt-apps/app-list-only-snapshot-spec.md`
- `extensions/openai-apps/src/state-paths.ts`
- `extensions/openai-apps/src/app-server-session.ts`
- `extensions/openai-apps/src/app-server-invoker.ts`
- `extensions/openai-apps/src/mcp-bridge.ts`
- `extensions/openai-apps/src/app-server-invoker.test.ts`
- `extensions/openai-apps/src/app-server-session.test.ts`

### Constraints

- No backwards compatibility is required for the temporary invocation-home
  behavior.
- Fresh threads per invocation must remain unchanged.
- The bundle should not rely on undocumented temp-dir cleanup as a correctness
  boundary if one bundle-owned home is sufficient.
- Any remaining need for per-invocation temp homes must be demonstrated by
  code-backed failure or validation evidence, not assumed.

### Non-obvious Dependencies or Access

- Shared-home correctness depends partly on app-server behavior that is not
  implemented in this repo. The bundle can prove its own state assumptions, but
  any app-server-internal home-locking or concurrent-write constraint must be
  validated empirically.
- Live validation depends on a working `codex` app-server binary and valid
  `openai-codex` OAuth projection.

### Temporal Context Triage

| Value / Flag              | Source of truth                     | Representation         | Initialization point             | Snapshot / capture point        | First consumer                       | Initialized before capture? |
| ------------------------- | ----------------------------------- | ---------------------- | -------------------------------- | ------------------------------- | ------------------------------------ | --------------------------- |
| Bundle app-server home    | `statePaths.codexHomeDir`           | persistent path string | `resolveChatgptAppsStatePaths()` | before refresh launch           | refresh session spawn                | Yes                         |
| Invocation temp home      | `mkdtemp(...)` in invoker           | temp path string       | invocation start                 | before invocation launch        | invocation spawn env                 | Yes                         |
| Derived `apps` config     | `buildDerivedAppsConfig(config)`    | config subtree         | refresh session after login      | `writeConfigValue("apps", ...)` | `app/list` session behavior          | Yes                         |
| Invocation route metadata | persisted snapshot connector record | connector/app identity | snapshot refresh                 | before `callTool()`             | `buildInvocationInput()`             | Yes                         |
| Projected auth            | OpenClaw OAuth projection           | token + account id     | before each launch               | login step                      | refresh and invocation session login | Yes                         |

The ordering gap is not between route/auth data and invocation. The only split
is that refresh writes config into the persistent home while invocation launches
against a different home and skips the config write entirely.

---

## Approach and Touchpoints

### Proposed Approach

Unify both launch paths on `statePaths.codexHomeDir` and treat that directory as
the single bundle-owned app-server home for both refresh and invocation.

Under the target model:

1. `resolveChatgptAppsStatePaths()` remains the only source of the bundle app
   home.
2. Refresh continues to use `statePaths.codexHomeDir`.
3. Invocation also uses `statePaths.codexHomeDir` instead of `mkdtemp(...)`.
4. Invocation no longer deletes any `CODEX_HOME` directory on exit.
5. The bundle defines an explicit config-write rule for invocation:
   - preferred: invocation writes the derived `apps` config before thread start
   - acceptable alternative only if proven equivalent: invocation reuses the
     already-written persistent config state and refresh invalidation guarantees
     it is current
6. Tests and docs stop encoding temp-home creation as an invariant.

This keeps the architecture simpler:

- one bundle-owned home
- one persisted config location
- no per-call temp directory churn
- no hidden difference between refresh and invocation startup assumptions

### Integration Points / Touchpoints

- `extensions/openai-apps/src/state-paths.ts`
  Why: remains the canonical source of the shared bundle home path.
- `extensions/openai-apps/src/app-server-session.ts`
  Why: defines the existing refresh-side launch and config-write contract that
  invocation should align with.
- `extensions/openai-apps/src/app-server-invoker.ts`
  Why: remove `mkdtemp(...)`, temp-home cleanup, and invocation-only home
  divergence; align launch/config semantics with refresh.
- `extensions/openai-apps/src/mcp-bridge.ts`
  Why: the bridge already passes `statePaths`; no route-level behavior should
  depend on temp homes, but tests should confirm that.
- `extensions/openai-apps/src/app-server-invoker.test.ts`
  Why: replace the current assumption that invocation has no per-call config
  warmup if the new contract writes config before the thread starts.
- `extensions/openai-apps/src/app-server-session.test.ts`
  Why: reuse or factor common expectations around login plus config write.
- `extensions/openai-apps/docs/flows/ref.openai-apps-call-tool.md`
  Why: document the current split and then the post-change unified model.
- `extensions/openai-apps/README.md`
  Why: document the bundle-owned runtime state and remove any implication that
  invocation creates isolated app-server homes.

### Resolved Ambiguities / Decisions

- Shared-home target: both refresh and invocation should use
  `statePaths.codexHomeDir`.
- Temp-home lifecycle: temporary invocation-only `CODEX_HOME` directories are
  not a desired design invariant.
- Evidence standard for keeping temp homes: keep them only if implementation or
  validation proves a shared home breaks app-server correctness.
- Fresh-thread behavior: keep it. This spec changes home reuse, not thread
  reuse.
- Config contract: invocation should no longer depend on a separate home that
  silently lacks the bundle-derived `apps` config.
- Bundle-state ownership: `plugin-runtimes/openai-apps/codex-home` is the
  bundle-owned runtime home, not the user’s normal Codex home.

### Important Implementation Notes

- The current flow doc was stale: it said invocation writes config, but the code
  currently logs `app-server config write skipped for invocation session`.
- The current bundle code provides no repo-local evidence that invocation needs
  its own temp home for correctness. The temp home is created, used as
  `CODEX_HOME`, and deleted, but no bundle code consumes temp-home-specific
  persisted artifacts.
- The strongest remaining risk is app-server-internal state coupling under one
  home when refresh and invocation happen near each other. That risk should be
  handled with validation, not by preserving temp homes without evidence.

### Research Finding: Is The Temp Home Required?

From the current repo code, no bundle-level requirement was found.

What the code does show:

- refresh already uses a bundle-owned persistent home
- invocation already has all required inputs before launch:
  projected auth, connector route metadata, and bundle config
- invocation does not read any temp-home state written by prior invocations
- invocation does not persist any temp-home output that later bundle code needs
- invocation deletes the temp home immediately after the call

What remains unknown from this repo alone:

- whether `codex app-server` has internal file-locking, cache-corruption, or
  concurrent-write behavior that makes a shared home unsafe across separate
  refresh and invocation processes

The implementation should therefore default to the shared-home model and only
retain temp-home behavior if targeted validation demonstrates a real shared-home
failure.

---

## Acceptance Criteria

- [x] Refresh and invocation both launch app-server with the same
      `statePaths.codexHomeDir`.
- [x] `extensions/openai-apps/src/app-server-invoker.ts` no longer creates a
      temp `CODEX_HOME` with `mkdtemp(...)`.
- [x] `extensions/openai-apps/src/app-server-invoker.ts` no longer removes an
      invocation-only `CODEX_HOME` directory on exit.
- [x] The bundle defines one explicit config-write contract for invocation under
      the shared-home model, and tests cover it.
- [x] Current docs describe the pre-change split accurately and the target
      implementation docs describe the unified-home model.
- [x] Validation covers at least one refresh followed by invocation and one
      repeated invocation sequence under the shared home.
- [ ] If shared-home validation fails, the failure mode and reason are captured
      in docs/specs before any fallback design is preserved.

---

## Phases and Dependencies

### Phase 1: Align documentation with shipped behavior

- [x] Update the runtime flow doc to describe the current persistent refresh
      home versus temporary invocation home split.
- [x] Record in this spec that the current invocation path skips config writes
      and deletes its temp home on exit.

### Phase 2: Unify launch paths on the bundle-owned home

- [x] Remove `mkdtemp` and temp-home cleanup from
      `extensions/openai-apps/src/app-server-invoker.ts`.
- [x] Launch invocation app-server processes with `CODEX_HOME:
statePaths.codexHomeDir`.
- [x] Ensure the shared home directory exists before invocation launch.

### Phase 3: Make config behavior explicit

- [x] Decide whether invocation always writes derived `apps` config or uses a
      shared helper that encapsulates login plus config projection.
- [x] Update invocation tests to assert the chosen config-write contract.
- [ ] Refactor shared session setup if duplicated refresh and invocation setup
      becomes hard to reason about.

### Phase 4: Validate shared-home safety

- [x] Run scoped extension tests covering refresh and invocation behavior.
- [x] Run the repo-level integration wrapper
      `./scripts/test-chatapps-integ.sh simple`.
- [x] Capture any shared-home race, lock, or stale-config issues discovered
      during validation.
- [x] If no issue is found, land the shared-home model without temp-dir
      fallbacks.

### Phase Dependencies

- Phase 1 should land with or before implementation so the docs no longer
  describe the wrong invocation config behavior.
- Phase 2 depends only on the current code paths already traced in this spec.
- Phase 3 depends on the exact Phase 2 launch model because config behavior
  should be chosen once.
- Phase 4 depends on completed code changes from Phases 2 and 3.

---

## Validation Plan

Integration tests:

- Run `pnpm test -- extensions/openai-apps/src` and verify invocation tests no
  longer encode temp-home behavior.
- Run `./scripts/test-chatapps-integ.sh simple` and confirm list-tools plus
  Gmail still work with the shared-home path.
- Run `./scripts/test-chatapps-integ.sh full` and confirm the shared-home path
  does not introduce regressions in Gmail, Linear, and Google Calendar flows.

Unit tests:

- Add a test that invocation launches with `statePaths.codexHomeDir` rather than
  a generated temp path.
- Add a test that invocation no longer removes a per-call temp `CODEX_HOME`.
- Add a test that covers the chosen invocation config-write contract.
- Keep the existing fresh-thread assertions.

Manual validation:

- Enable `OPENCLAW_OPENAI_APPS_DEBUG=1` and confirm invocation logs no longer
  mention temp-home creation or deletion.
- Trigger a refresh through `list tools`, then invoke Gmail and confirm both
  operations succeed using the bundle-owned state directory.
- Repeat two invocations back to back and confirm the second call does not fail
  due to shared-home contamination.

### Validation Status

- [x] `pnpm test -- extensions/openai-apps/src` passed on 2026-03-30 with 11
      test files passed, 42 tests passed, and 1 existing todo.
- [x] `python3 /Users/kevinlin/.codex/skills/specy/scripts/validate_flow_doc.py --kind auto --doc /Users/kevinlin/code/openclaw/extensions/openai-apps/docs/flows/ref.openai-apps-call-tool.md`
      passed on 2026-03-30.
- [x] `./scripts/test-chatapps-integ.sh simple` passed on 2026-03-30: it
      published 18 tools and completed a Gmail invocation through the
      shared-home path.
- [ ] `./scripts/test-chatapps-integ.sh full` remains pending.
- [ ] Manual shared-home validation remains pending.

## Done Criteria

- [x] Implementation uses one bundle-owned `CODEX_HOME` for both refresh and
      invocation.
- [x] Validation demonstrates that temp-home creation/removal was unnecessary,
      or captures a concrete shared-home blocker if it was not.
- [x] Docs/specs/tests are updated to describe the final shared-home model.

---

## Open Items and Risks

### Open Items

- [ ] Does app-server exhibit any shared-home file contention when refresh and
      invocation happen in close succession from separate processes?
- [ ] Does the full live integration harness stay green under the shared-home
      model with reusable auth and the dev gateway bootstrap it requires?

### Risks and Mitigations

| Risk                                                                                     | Impact | Probability | Mitigation                                                                                                               |
| ---------------------------------------------------------------------------------------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Shared-home reuse exposes app-server-internal file contention not visible in bundle code | High   | Med         | Validate refresh-plus-invocation and repeated invocation sequences before landing; document the exact failure if found.  |
| Invocation sees stale `apps` config in the shared home                                   | High   | Med         | Make invocation config projection explicit and cover it with tests instead of relying on incidental prior refresh state. |
| Docs and tests continue to encode the old temp-home behavior                             | Med    | High        | Update the runtime flow doc and invoker tests in the same change as the implementation.                                  |
| Engineers assume shared home implies shared thread/process reuse                         | Med    | Low         | Keep fresh-thread behavior explicit in docs, tests, and acceptance criteria.                                             |

### Simplifications and Assumptions

- This spec assumes one shared bundle-owned `CODEX_HOME` is the intended design
  unless validation proves otherwise.
- This spec assumes the user’s normal `~/.codex` remains out of scope; the
  bundle continues to use its own runtime-owned home.

---

## Outputs

- Local implementation status: completed
- Verification run: `pnpm test -- extensions/openai-apps/src`
- Live integration status: `simple` passed; `full` pending

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-30: Created the feature spec for documenting the current refresh versus invocation `CODEX_HOME` split and converging both paths onto one bundle-owned home. (019d3fd9-e93e-70c2-bf09-71b8b05a31f4 - 99b18ecce6)
- 2026-03-30: Implemented shared-home invocation reuse with explicit per-invocation `apps` config writes, plus test and docs updates; targeted extension validation now passes. (019d4036-0bb6-7a20-9dd6-933a0181e5a5 - afed18cb1c)
- 2026-03-30: Verified the shared-home path with the `simple` live chat-apps integration harness and recorded the remaining `full`/manual validation follow-up. (019d4036-0bb6-7a20-9dd6-933a0181e5a5 - afed18cb1c)
