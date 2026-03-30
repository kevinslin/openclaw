# Feature Design: ChatGPT Apps via OpenAI Bundle MCP Bridge

**Date:** 2026-03-28  
**Status:** Draft  
**Owner:** OpenAI plugin / ChatGPT apps bundle

## Goal

Expose ChatGPT apps inside OpenClaw by shipping a separate bundle-owned stdio
MCP bridge that:

- reads OpenClaw-owned `openai-codex` auth and `chatgptApps` config at runtime
- spawns `codex app-server` only when connector refresh work is needed
- persists a connector snapshot with a 24-hour TTL
- rewrites and publishes ChatGPT app tools as ordinary MCP tools

This design intentionally does **not** use `registerService(...)` in the
existing native `openai` plugin and does **not** add any new OpenClaw core or
runtime behavior.

## Scope

In scope:

- Create a separate Codex bundle package for ChatGPT apps instead of extending
  native plugin runtime registration.
- Reuse the proven app-server supervisor, auth projection, endpoint derivation,
  and MCP bridge logic from the prior branch, but move all of it into the
  bundle-owned MCP subprocess.
- Use `/Users/kevinlin/code/codex-sdk-ts` as the local app-server SDK
  dependency instead of copying generated app-server types into this repo.
- Keep OpenClaw as the root auth sink and project external ChatGPT tokens into
  `codex app-server` only for refresh work.
- Use `app/list` as the authoritative app inventory and cache the connector
  snapshot for 24 hours unless an explicit hard refresh is requested.
- Keep all ChatGPT-app behavior inside plugin code only, including native
  plugin config schema, bundle manifests, bridge process, auth projection, and
  cache files.

Out of scope:

- Any changes under `src/` that introduce new runtime primitives, new managed
  MCP registries, new background service concepts, or new bundle lifecycle
  hooks.
- Replacing OpenClaw-owned `openai-codex` OAuth storage with Codex-owned auth.
- Reimplementing Codex app-server types inside OpenClaw.
- Keeping a long-lived app-server process alive across bundle bridge
  invocations.
- Shipping a model-visible hard-refresh tool or native link/install helper in
  milestone 1.

## Current State

- The current `openai` plugin is a native plugin that registers providers and a
  CLI backend, but it does not expose ChatGPT apps today.
- OpenClaw already supports bundle-declared stdio MCP servers through
  `.codex-plugin/plugin.json` plus `.mcp.json`, and merges those servers into
  embedded Pi session config without new runtime work.
- The prior ChatGPT-apps branch proved the useful logic, but its native plugin
  implementation coupled app-server ownership to `registerService(...)`,
  `registerMcpServer(...)`, and additional runtime plumbing that we do not want
  to keep.
- The current public plugin SDK already exposes config and auth runtime helpers
  that bundle code can call directly.
- Bundle detection precedence matters: if a directory has both
  `openclaw.plugin.json` and `.codex-plugin/plugin.json`, OpenClaw treats it as
  a native plugin, not a bundle. A real bundle therefore cannot live in the
  existing `extensions/openai` package root.
- Bundle MCP subprocesses inherit normal OpenClaw environment such as
  `OPENCLAW_STATE_DIR`, which lets bundle code resolve a deterministic plugin
  runtime cache path without new runtime support.

### Temporal Context Triage

| Value / Flag                | Source of truth              | Representation                                             | Initialization point                  | Snapshot / capture point                 | First consumer                                          | Initialized before capture? |
| --------------------------- | ---------------------------- | ---------------------------------------------------------- | ------------------------------------- | ---------------------------------------- | ------------------------------------------------------- | --------------------------- |
| `openai-codex` access token | OpenClaw auth profile store  | bearer token string                                        | OpenClaw OAuth login / refresh        | bundle refresh path                      | sidecar `account/login/start` and remote MCP calls      | Yes                         |
| ChatGPT account id          | OpenClaw auth profile store  | account id string                                          | OpenClaw OAuth login metadata         | bundle refresh path                      | sidecar `account/login/start` and remote MCP headers    | Yes                         |
| `chatgptApps` config        | OpenClaw config              | `plugins.entries.openai.config.chatgptApps` object         | config load in bundle bridge          | bridge startup / refresh path            | config normalization, derived sidecar config, filtering | Yes                         |
| Derived sidecar apps config | bundle refresh path          | isolated Codex apps config file                            | immediately before `app/list` refresh | same refresh transaction                 | app-server `AppInfo.isEnabled` computation              | Yes                         |
| Connector snapshot cache    | bundle-owned persisted file  | `AppInfo[]` plus tool/status metadata and freshness inputs | first successful refresh              | bridge `tools/list` / route-rebuild path | local tool publication and route recovery               | Yes after first refresh     |
| In-memory route cache       | bundle bridge memory         | local tool name -> connector/tool route                    | after snapshot load                   | before `tools/list` / `tools/call`       | `tools/call`                                            | Yes                         |
| Hard refresh flag           | operator/debug startup input | boolean                                                    | bridge startup or manual invocation   | before snapshot decision                 | refresh invalidation logic                              | Yes                         |

The only ordering-sensitive value is the connector snapshot cache. When it is
missing, expired, or invalidated, the bridge must run a short-lived refresh
session before publishing tools or rebuilding routes.

## Requirements -> Design Mapping

| Requirement                                                                | Design Decision                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep all new behavior out of the OpenClaw runtime                          | Use only existing bundle MCP loading, existing plugin-sdk config/auth helpers, and native plugin config schema; do not edit `src/` runtime code                                                                         |
| Avoid `registerService(...)` in the native `openai` plugin                 | Keep the native `openai` plugin as config/auth owner only; the bundle subprocess owns sidecar lifecycle inside `tools/list` / refresh paths                                                                             |
| Reuse the proven app-server logic instead of inventing a new control plane | Keep the old branch's app-server supervisor, auth projector, endpoint derivation, and bridge logic, but colocate them inside the bundle process                                                                         |
| Preserve OpenClaw ownership of `openai-codex` auth                         | Read OpenClaw config/auth via existing plugin-sdk runtime helpers and project `chatgptAuthTokens` into the short-lived sidecar only for refresh work                                                                    |
| Keep `app/list` authoritative                                              | Treat `app/list` as the connector inventory source of truth and persist its output into a bundle-owned snapshot before tools are published                                                                              |
| Keep operator enablement in OpenClaw config                                | Continue to read `plugins.entries.openai.config.chatgptApps`, then have the bundle write an isolated derived Codex apps config before `app/list` so `AppInfo.isEnabled` matches OpenClaw intent                         |
| Keep discovery efficient without a background service                      | Persist one bundle-owned connector snapshot under `OPENCLAW_STATE_DIR/plugin-runtimes/openai-chatgpt-apps/`, keep it for 24 hours, and only spawn `codex app-server` again on TTL expiry, invalidation, or hard refresh |
| Avoid vendoring the app-server SDK                                         | Add a local dependency on `/Users/kevinlin/code/codex-sdk-ts` and import its generated protocol/client subpaths directly                                                                                                |
| Keep behavior safe and auditable                                           | Publish ChatGPT apps as ordinary MCP tools so existing OpenClaw tool approval, transcript, and audit paths remain unchanged                                                                                             |
| Respect bundle detection precedence                                        | Put the new bundle in a separate package root; do not add bundle markers to `extensions/openai/`                                                                                                                        |

## Proposed Design

### 1) Ship a separate OpenAI ChatGPT apps bundle package

The new implementation should live in a bundle-only package root such as:

- `extensions/openai-chatgpt-apps-bundle/.codex-plugin/plugin.json`
- `extensions/openai-chatgpt-apps-bundle/.mcp.json`
- `extensions/openai-chatgpt-apps-bundle/package.json`
- `extensions/openai-chatgpt-apps-bundle/src/*`

This package stays separate from `extensions/openai/` because native plugin
manifests win over bundle manifests. If bundle markers were added to
`extensions/openai/`, OpenClaw would still treat that directory as a native
plugin and the bundle path would never be exercised.

The native `openai` plugin remains in place as the auth owner, provider
surface, and config-schema owner. The bundle is an add-on that exposes
ChatGPT app tools through MCP.

### 2) Keep app-server lifecycle inside the bundle bridge and spawn it only when needed

The previous branch introduced useful app-server logic that should survive:

- `app-server-command.ts`
- `app-server-supervisor.ts`
- `auth-projector.ts`
- `remote-codex-apps-client.ts`
- `mcp-bridge.ts`

What changes in this design is ownership and lifetime:

- remove native `registerService(...)`
- remove any service-to-bundle control channel
- keep the bundle MCP bridge as the only runtime owner of app-server refresh
  work

The bundle process should stay cheap on cold start. It does **not** prewarm
`codex app-server` when the bundle server starts. Instead:

1. `tools/list` or route-rebuild logic loads the persisted snapshot
2. if the snapshot is fresh, the bridge publishes from cache only
3. if the snapshot is stale, missing, or hard-refresh is set, the bridge
   launches a short-lived `codex app-server` refresh session
4. after refresh completes, the bridge tears the sidecar down

This keeps the implementation simple:

- no background gateway service
- no bundle-to-service IPC
- no long-lived sidecar lease shared across sessions

The tradeoff is acceptable for now: different bridge processes may occasionally
perform duplicate refresh work when the cache is stale. That is bounded by the
24-hour TTL and by atomic snapshot replacement.

### 3) Keep OpenClaw as the root auth sink and project auth into the app-server when necessary

OpenClaw keeps ownership of `openai-codex` OAuth storage and refresh. The
bundle should use existing exported helpers:

- `openclaw/plugin-sdk/config-runtime`
- `openclaw/plugin-sdk/provider-auth`

The refresh path is:

1. load OpenClaw config
2. resolve the active `openai-codex` credential
3. require a usable access token and ChatGPT account id
4. spawn `codex app-server`
5. call `account/login/start` with `type: "chatgptAuthTokens"`
6. continue with inventory refresh work
7. stop the short-lived app-server session after refresh completes

Important behavior carried over from the source docs:

- external ChatGPT auth does not proactively self-refresh inside the sidecar
- the bundle must refresh auth in OpenClaw first, then re-project it
- a missing account id is a hard failure for ChatGPT apps

### 4) Use `app/list` as the authoritative app inventory

`app/list` remains the only authoritative connector inventory surface.
OpenClaw should not synthesize app availability from raw `/api/codex/apps`
responses or other undocumented connector directory shapes.

When the bundle refreshes connector state, it should:

- call paginated `app/list` until `nextCursor == null`
- treat the returned `AppInfo[]` as the canonical connector inventory
- optionally collect `legacy app-status RPC` in the same refresh pass so the
  bridge can keep connector-to-tool metadata next to the inventory snapshot
- store the final snapshot in a bundle-owned cache file

`app/list` answers which connectors are visible, accessible, and enabled.
`legacy app-status RPC` is an implementation detail for tool metadata, not the
source of truth for app inventory.

### 5) Mirror OpenClaw enablement into an isolated sidecar config

Operator control should stay in OpenClaw config under the native `openai`
plugin entry:

```json
{
  "plugins": {
    "entries": {
      "openai": {
        "config": {
          "chatgptApps": {
            "enabled": false,
            "appServer": {
              "command": "codex",
              "args": []
            },
            "connectors": {
              "google_drive": { "enabled": true },
              "gmail": { "enabled": false }
            }
          }
        }
      }
    }
  }
}
```

Before each connector refresh, the bundle writes a derived Codex apps config
inside its own state sandbox so `AppInfo.isEnabled` matches OpenClaw config
instead of unrelated user-authored `~/.codex` state.

That keeps precedence clear:

1. top-level `mcp.servers` can still override the final MCP server definition
2. `plugins.entries.openai.config.chatgptApps` owns ChatGPT-app policy
3. the sidecar config file is derived state, not operator-authored state

### 6) Add a local stdio MCP bridge for actual tool exposure

The bundle's `.mcp.json` should declare exactly one stdio server, for example
`openai-chatgpt-apps`. That bridge is the only MCP exposure layer:

- loads bundle config and bundle-owned persisted snapshot state
- requests a refresh by launching a short-lived app-server session when needed
- rewrites tool names into a collision-safe local namespace
- forwards tool calls to the remote ChatGPT apps MCP endpoint

Local tool naming stays deterministic:

```text
chatgpt_app__<connectorId>__<toolName>
```

This avoids collisions with:

- native OpenClaw tools
- tools from other MCP servers
- overlapping tool names across connectors

### 7) Use the correct ChatGPT apps endpoint derivation

The bridge should derive its remote endpoint from a bundle-owned constant for
the ChatGPT app surface:

- `https://chatgpt.com` -> `https://chatgpt.com/backend-api/wham/apps`

This remains separate from the OpenClaw model transport base URL. The bundle
should keep that endpoint internal instead of exposing it as a user-configurable
setting.

### 8) Define cache boundaries and invalidation

This design keeps a bundle-owned persisted snapshot plus a bridge-owned
in-memory route cache.

#### Bundle-owned connector snapshot cache

Recommended location:

- derive from `OPENCLAW_STATE_DIR`
- use `${OPENCLAW_STATE_DIR}/plugin-runtimes/openai-chatgpt-apps/`
- write:
  - `connectors.snapshot.json`
  - `codex-apps.config.json`
  - optional `refresh-debug.json` for operator diagnostics

Source:

- `app/list`
- optional `legacy app-status RPC`

Contents:

- `AppInfo[]`
- connector tool/status metadata captured in the same refresh pass
- `fetchedAt`
- account id
- config hash
- base URL hash

Lifetime:

- valid for 24 hours by default
- reused across bridge restarts and across later session startups

Invalidated by:

- explicit hard refresh
- account id change
- access token owner change
- `chatgptApps` config hash change
- TTL expiry
- missing or corrupt snapshot state

Write rules:

- refresh writes must be atomic
- failed refreshes must not replace the last known good snapshot
- concurrent refreshes are allowed initially; atomic writes keep the final
  snapshot coherent even if duplicate refresh work happens

#### In-memory tool routing cache

Source:

- rewritten names derived from the connector snapshot

Contents:

- local tool name -> connector id + remote tool name

Lifetime:

- current bridge process only

Invalidated by:

- connector snapshot change
- bridge restart

### 9) Keep OpenClaw safety and audit semantics unchanged

ChatGPT apps still show up as ordinary MCP tools. That means:

- normal tool approval still applies
- OpenClaw transcript and audit paths still record the calls
- sandbox policy still applies to the OpenClaw session as a whole
- there is no direct in-process bypass for ChatGPT apps

This design adds new tools, but it does not add a new trust model.

## Feature Gates and Toggles

| Toggle / Gate                                          | Scope                     | Behavior When Off                                         | Behavior When On                                                                   |
| ------------------------------------------------------ | ------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Bundle installed and enabled                           | plugin discovery          | No ChatGPT-app bridge server exists                       | Bundle `.mcp.json` contributes one stdio MCP server                                |
| `plugins.entries.openai.config.chatgptApps.enabled`    | bridge startup            | Bundle returns no app tools and does not run refresh work | Bundle may publish tools and run refresh on cache miss                             |
| `plugins.entries.openai.config.chatgptApps.connectors` | derived sidecar config    | Default connector policy applies                          | `AppInfo.isEnabled` and local filtering follow explicit connector settings         |
| Hard refresh flag                                      | bundle refresh path       | 24-hour cache is reused while valid                       | Bundle ignores the persisted connector cache and rebuilds it from app-server state |
| Top-level `mcp.servers` override                       | operator-owned MCP config | Bundle default server definition is used                  | Operator override replaces or amends the bridge server definition                  |

## Parity and Migration Audit

- Preserve:
  - the Codex app-server supervisor code from the old branch
  - OpenClaw-owned `openai-codex` auth and `chatgptAuthTokens` projection
  - `app/list` as the authoritative connector inventory
  - isolated derived sidecar config so `AppInfo.isEnabled` matches OpenClaw
  - collision-safe local tool names and unchanged approval/audit semantics
- Move:
  - app-server lifecycle into the bundle MCP subprocess
  - connector snapshot persistence into bundle-owned state under
    `OPENCLAW_STATE_DIR`
  - generated protocol imports from vendored files to the local
    `codex-sdk-ts` dependency
- Intentionally drop:
  - `registerService(...)`
  - service-to-bundle IPC and shared control metadata
  - any new OpenClaw runtime primitive beyond the current bundle MCP loading
  - proactive gateway-start sidecar warm-up
  - native plugin inspect/status parity for live sidecar state in milestone 1
- Local-only constraint:
  - `file:/Users/kevinlin/code/codex-sdk-ts` is acceptable for local design and
    development, but it is not shippable as a marketplace or CI artifact

## Integration Flows

### Session startup flow

1. OpenClaw loads enabled plugins and bundle MCP config.
2. If `chatgptApps.enabled == false`, the bundle publishes no app tools.
3. If enabled, OpenClaw launches the bundle-owned stdio MCP bridge like any
   other bundle MCP server.
4. The bridge loads OpenClaw config plus its persisted snapshot state from
   `OPENCLAW_STATE_DIR/plugin-runtimes/openai-chatgpt-apps/`.
5. If the snapshot is fresh, the bridge publishes tools from cache only.
6. If the snapshot is stale or missing, the first `tools/list` or route rebuild
   triggers a short-lived app-server refresh session inside the bridge.

### Connector refresh flow

1. Bridge decides that the snapshot is missing, stale, invalidated, or hard
   refresh was requested.
2. Bridge loads OpenClaw config and resolves `openai-codex` auth.
3. Bridge spawns `codex app-server`.
4. Bridge projects auth with `account/login/start(chatgptAuthTokens)`.
5. Bridge writes the derived sidecar config for connector enablement.
6. Bridge calls paginated `app/list`.
7. Bridge optionally calls `legacy app-status RPC` in the same refresh pass.
8. Bridge atomically writes the refreshed connector snapshot cache.
9. Bridge tears down the short-lived app-server session.

### Tool list flow

1. OpenClaw runtime calls the bundle bridge `tools/list`.
2. Bridge loads the persisted connector snapshot.
3. If the snapshot is stale or absent, the bridge refreshes it first by
   running the connector refresh flow.
4. Bridge rewrites cached connector tools into the local
   `chatgpt_app__<connectorId>__<toolName>` namespace.
5. Bridge filters out connectors whose `AppInfo` is not both accessible and
   enabled.
6. Bridge returns local MCP tool definitions.

### Tool call flow

1. OpenClaw runtime calls a rewritten ChatGPT app tool.
2. Bridge resolves the stored local route metadata.
3. If route metadata is missing because the bridge restarted, it rebuilds the
   in-memory route map from the persisted snapshot.
4. If the snapshot is missing or no longer usable for route rebuild, the bridge
   refreshes it first by running the connector refresh flow.
5. Bridge resolves current OpenClaw auth from the shared OpenClaw auth store.
6. Bridge calls the remote ChatGPT apps MCP endpoint directly with:
   - `Authorization: Bearer <token>`
   - `ChatGPT-Account-ID: <accountId>`
7. Bridge forwards the result through the normal MCP response path.

## Detailed File Plan

- `docs/specs/2026-03-chatgpt-apps/design.md`: design doc aligned with the
  bundle-owned architecture.
- `extensions/openai/openclaw.plugin.json`: add `chatgptApps` config schema so
  the bundle can read operator-owned settings from the native `openai` plugin
  entry.
- `extensions/openai-chatgpt-apps-bundle/package.json`: create the bundle
  package with `codex-sdk-ts` as a local `file:` dependency plus MCP/runtime
  dependencies.
- `extensions/openai-chatgpt-apps-bundle/.codex-plugin/plugin.json`: Codex
  bundle manifest for discovery.
- `extensions/openai-chatgpt-apps-bundle/.mcp.json`: declare the single stdio
  bridge server.
- `extensions/openai-chatgpt-apps-bundle/src/server.ts`: stdio entrypoint that
  instantiates the bridge and parses an optional hard-refresh flag for manual
  runs/tests.
- `extensions/openai-chatgpt-apps-bundle/src/config.ts`: normalize
  `plugins.entries.openai.config.chatgptApps` and compute the config hash used
  for refresh invalidation.
- `extensions/openai-chatgpt-apps-bundle/src/state-paths.ts`: deterministic
  path helpers for the bundle-owned runtime cache under `OPENCLAW_STATE_DIR`.
- `extensions/openai-chatgpt-apps-bundle/src/app-server-command.ts`: resolve
  the `codex` executable and sidecar args from config.
- `extensions/openai-chatgpt-apps-bundle/src/app-server-session.ts`: short-lived
  sidecar session wrapper around `codex app-server`.
- `extensions/openai-chatgpt-apps-bundle/src/auth-projector.ts`: project
  OpenClaw-owned auth into the sidecar via `chatgptAuthTokens`.
- `extensions/openai-chatgpt-apps-bundle/src/snapshot-cache.ts`: read, write,
  hash, and invalidate persisted connector snapshots.
- `extensions/openai-chatgpt-apps-bundle/src/refresh-snapshot.ts`: run the
  refresh transaction from config/auth resolution through atomic snapshot write.
- `extensions/openai-chatgpt-apps-bundle/src/remote-codex-apps-client.ts`:
  direct remote MCP client plus ChatGPT apps endpoint derivation.
- `extensions/openai-chatgpt-apps-bundle/src/mcp-bridge.ts`: filter connector
  tools, rewrite names, maintain route metadata, and forward calls.
- `extensions/openai-chatgpt-apps-bundle/src/*.test.ts`: targeted unit and
  integration tests for config, cache invalidation, endpoint derivation,
  refresh, and end-to-end bridge behavior.

## Planning & Milestones

Every milestone must ship a significant and verifiable piece of functionality.

### Milestone 1: Bundle skeleton and bundle-owned state contract

**Shipped functionality:** OpenClaw can detect the new bundle, load its stdio
MCP server, and the bridge can resolve config plus deterministic bundle-owned
state paths without any runtime changes.

Tasks:

- create `extensions/openai-chatgpt-apps-bundle/`
- add `.codex-plugin/plugin.json`
- add `.mcp.json`
- add package build/test scripts
- add the local `file:/Users/kevinlin/code/codex-sdk-ts` dependency
- add `chatgptApps` config schema in `extensions/openai/openclaw.plugin.json`
- port `app-server-command.ts`, `auth-projector.ts`, and bridge entry wiring
  into the bundle package
- define the bundle-owned runtime cache layout under `OPENCLAW_STATE_DIR`

Verification:

- OpenClaw detects the new package as a Codex bundle, not a native plugin
- the bundle contributes exactly one stdio MCP server
- no native `openai` service registration is introduced
- no OpenClaw runtime files under `src/` are modified

### Milestone 2: On-demand refresh and cached tool publication

**Shipped functionality:** The bundle can spawn `codex app-server` on demand,
refresh connector state through it, cache that state for 24 hours, and publish
only accessible and enabled ChatGPT app tools.

Tasks:

- port the app-server refresh transaction into the bundle bridge
- project OpenClaw auth with `chatgptAuthTokens`
- write isolated derived sidecar config before `app/list`
- implement paginated `app/list`
- optionally capture `legacy app-status RPC` in the same refresh pass
- persist bundle-owned connector snapshot cache with TTL and invalidation rules
- rewrite tool names into the local namespace

Verification:

- the first `tools/list` on a cold cache launches a short-lived app-server
  refresh session
- subsequent `tools/list` uses the persisted snapshot while the TTL is valid
- connector enablement changes invalidate the cache and change published tools
- inaccessible or disabled connectors do not publish tools
- failed refreshes do not replace the last known good snapshot

### Milestone 3: Direct remote tool execution and local-ops hardening

**Shipped functionality:** Published ChatGPT app tools can execute through the
remote MCP endpoint while preserving OpenClaw audit semantics.

Tasks:

- port remote MCP client logic into the bundle package
- forward tool calls with OpenClaw-owned auth headers
- rebuild route metadata after bridge restart from the persisted snapshot
- add an operator/debug hard-refresh path that bypasses TTL inside the bundle
- document the local-only `codex-sdk-ts` dependency constraint for dogfooding

Verification:

- rewritten ChatGPT app tools execute end to end
- bridge restart does not require runtime changes to recover tool routes
- hard refresh bypasses the 24-hour connector cache
- OpenClaw transcripts still show ordinary MCP tool usage

### Milestone dependencies

- Milestone 2 depends on Milestone 1.
- Milestone 3 depends on Milestone 2.
- `extensions/openai/openclaw.plugin.json` schema work can happen in parallel
  with most of Milestone 1.

## Rollout Plan

Phase 0:

- land the design and bundle package behind
  `plugins.entries.openai.config.chatgptApps.enabled = false`
- keep the bundle disabled by default

Phase 1:

- dogfood locally with the bundle installed from the repo
- use the local `codex-sdk-ts` dependency path only on development machines

Phase 2:

- broaden internal dogfood after connector refresh, tool publication, and tool
  execution are stable
- decide whether to replace the local `file:` SDK dependency before any wider
  distribution

Rollback:

- disable `plugins.entries.openai.config.chatgptApps.enabled`
- or remove/disable the bundle installation entirely
- because no runtime surfaces change, rollback is limited to native plugin
  config and bundle state

## Testing Plan

Unit tests:

- config normalization and config-hash invalidation
- `codex` executable resolution
- ChatGPT apps endpoint derivation
- cache TTL and hard-refresh behavior
- tool-name rewriting and collision handling

Integration tests:

- bundle detection as Codex format
- stdio bridge `tools/list` against a fake app-server client
- paginated `app/list` refresh with derived sidecar config writes
- `tools/call` forwarding to a fake remote ChatGPT apps MCP endpoint
- restart recovery using the persisted connector snapshot cache

Manual checks:

- install the bundle locally and verify it is detected as `bundle format: codex`
- enable `plugins.entries.openai.config.chatgptApps.enabled`
- confirm the first cache miss launches a short-lived app-server refresh
- confirm repeated `tools/list` calls reuse the persisted snapshot instead of
  spawning again while the TTL is valid
- confirm deleting the snapshot or using hard refresh forces a new refresh run
- toggle a connector in OpenClaw config and verify the published tools change

## Observability

- log bundle refresh decisions: cache hit, cache miss, TTL expiry, account or
  config invalidation, hard-refresh bypass
- log sidecar spawn failures and auth projection failures with connector-refresh
  context
- persist `fetchedAt`, account id, and config hash with the connector snapshot
  for local debugging
- rely on existing OpenClaw MCP tool transcripts for execution auditing

## Risks and Mitigations

1. Bundle placement can silently fail if the package also looks native.

- Mitigation: keep the bundle in its own package root and do not add
  `.codex-plugin/plugin.json` to `extensions/openai/`.

2. The local `file:/Users/kevinlin/code/codex-sdk-ts` dependency is not
   portable across CI, release artifacts, or other machines.

- Mitigation: treat the `file:` dependency as local-development-only and gate
  broader rollout on a publishable dependency plan.

3. Without a native service, multiple bridge processes can do
   duplicate refresh work.

- Mitigation: keep the first version simple, bound duplication with the
  24-hour TTL, and rely on atomic snapshot replacement so final state stays
  coherent.

4. External auth projected into the sidecar does not self-refresh proactively.

- Mitigation: always refresh in OpenClaw first, then re-project into the
  sidecar before connector refresh work.

5. The first request after TTL expiry is slower because refresh happens inside
   the bundle subprocess.

- Mitigation: accept this as the tradeoff for avoiding new runtime lifecycle
  seams; only revisit if local dogfood shows startup cost is unacceptable.

6. Bundle-only ownership reduces native inspect/status visibility for live
   sidecar state.

- Mitigation: keep snapshot freshness metadata and refresh diagnostics in
  bundle-owned state; only add richer operator surfaces if dogfood shows they
  are necessary.

## Open Questions

1. Is an operator/debug-only hard-refresh flag sufficient, or do we want a
   model-visible refresh surface later?
2. Should `legacy app-status RPC` remain part of the persisted snapshot, or
   should the bridge rebuild tool metadata from another source on every refresh?
3. Do we want to add a best-effort file lock for cross-process refresh
   deduplication after the initial dogfood milestone?
4. Before broader distribution, do we want to publish `codex-sdk-ts`, make it a
   workspace dependency, or keep it local-only for this milestone?

## Appendix (Optional)

- Prior design docs that informed this rewrite:
  - `chatgpt-apps-bundle-milestone-specs/docs/specs/2026-03-chatgpt-apps/design.md`
  - `chatgpt-apps-bundle-milestone-specs/docs/specs/2026-03-chatgpt-apps-bundle-alternative/design.md`
- Codex flow docs that establish auth, inventory, and endpoint behavior:
  - `openai/0/notes/packages/codex/flows/topic.chatgpt-apps-auth-exposure.md`
  - `openai/0/notes/packages/codex/flows/ref.codex-apps-app-list-loading.md`
- Current OpenClaw bundle/runtime reference points:
  - `extensions/openai/openclaw.plugin.json`
  - `src/plugins/bundle-manifest.ts`
  - `src/plugins/bundle-mcp.ts`
  - `src/agents/embedded-pi-mcp.ts`
  - `docs/plugins/bundles.md`
- Local SDK dependency source:
  - `/Users/kevinlin/code/codex-sdk-ts/package.json`
  - `/Users/kevinlin/code/codex-sdk-ts/src/client.ts`

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-28: Reverted the design from native-service ownership back to a bundle-owned MCP bridge that spawns short-lived app-server refresh sessions on demand and persists its own connector snapshot cache. (019d37da-b9a9-72b1-9bda-231d842ceb58 - (cc55b9534a))
- 2026-03-28: Applied `dev.review` design feedback by making the service-to-bundle contract explicit, switching sidecar startup to lazy-on-first-refresh, and defining one namespaced shared-state root owned by plugin code. (019d37e9-33a5-7c21-954d-e2a1e366e205)
- 2026-03-28: Updated the design to use an existing native `openai` plugin service for long-lived app-server supervision while keeping the bundle bridge as the MCP exposure layer and avoiding any OpenClaw core changes. (019d37b7-f5d0-7fb0-9dba-462c01a18665 - (2638b566f1694da1a8248efc99f7fc94fbb59b94))
