# OpenAI Apps Runtime Environment Flow

Last updated: 2026-03-30

## Purpose

This flow documents how the `openai-apps` bundle determines its effective runtime environment before loading config or starting the MCP bridge. It answers where `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `OPENCLAW_AGENT_DIR` come from when they are not fully provided by the parent process.

## Entry points

- `extensions/openai-apps/src/server.ts`: bundle bootstrap that resolves runtime env before config load
- `extensions/openai-apps/src/runtime-env.ts`: env inference from explicit vars, lockfiles, and recent sessions
- `extensions/openai-apps/src/state-paths.ts`: downstream state-root derivation that consumes the resolved env

## Call path

### Phase 1: Bootstrap and capture explicit env inputs

Trigger / entry condition:

- The `openai-apps` bundle starts and `server.ts` enters `main()`.

Entrypoints:

- `extensions/openai-apps/src/server.ts:main`
- `extensions/openai-apps/src/runtime-env.ts:resolveOpenaiAppsRuntimeEnv`

Ordered call path:

1. Start bundle bootstrap by resolving runtime env before reading config.
   ```ts
   // Source: extensions/openai-apps/src/server.ts#L42-L51
   runtimeEnv := await resolveOpenaiAppsRuntimeEnv(process.env)
   writeDebugLog(runtimeEnv, "server main start")
   config := await loadRawConfig(runtimeEnv)
   await runChatgptAppsMcpBridgeStdio({
     loadOpenClawConfig: () => config,
     env: runtimeEnv,
   })
   ```
2. Normalize explicit env values and short-circuit when the full tuple is already present.
   ```ts
   // Source: extensions/openai-apps/src/runtime-env.ts#L152-L163
   explicitStateDir := normalizeOptionalString(env.OPENCLAW_STATE_DIR)
   explicitConfigPath := normalizeOptionalString(env.OPENCLAW_CONFIG_PATH)
   explicitAgentDir := normalizeOptionalString(env.OPENCLAW_AGENT_DIR)
   nextEnv := { ...env }
   if explicitStateDir && explicitConfigPath && explicitAgentDir
     return nextEnv
   ```

State transitions / outputs:

- Input: raw `process.env`
- Output: normalized explicit env values plus a mutable `nextEnv` copy

Branch points:

- When all three explicit values are already present, the inference flow exits early.

External boundaries:

- None identified

### Phase 2: Infer gateway context from local OpenClaw state

Trigger / entry condition:

- At least one of `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, or `OPENCLAW_AGENT_DIR` is missing.

Entrypoints:

- `extensions/openai-apps/src/runtime-env.ts:resolveOpenaiAppsRuntimeEnv`
- `extensions/openai-apps/src/runtime-env.ts:resolveGatewayRuntimeContextFromLocks`
- `extensions/openai-apps/src/runtime-env.ts:resolveGatewayRuntimeContextFromRecentSessions`

Ordered call path:

1. Derive baseline candidates from explicit `agentDir`, explicit config path, and `$HOME`.
   ```ts
   // Source: extensions/openai-apps/src/runtime-env.ts#L165-L173
   homeDir := normalizeOptionalString(env.HOME) ?? os.homedir()
   stateDirFromAgent := deriveStateDirFromAgentDir(explicitAgentDir) {
     marker := `${path.sep}agents${path.sep}`
     markerIndex := normalizedAgentDir.lastIndexOf(marker)
     if markerIndex <= 0
       return null
     return normalizedAgentDir.slice(0, markerIndex)
   }
   configDir := explicitConfigPath ? path.dirname(explicitConfigPath) : null
   lockContext := await resolveGatewayRuntimeContextFromLocks({ homeDir, parentPid })
   recentSessionContext := lockContext === null ? await resolveGatewayRuntimeContextFromRecentSessions({ homeDir }) : null
   ```
2. Search `.jsonl.lock` files under candidate `.openclaw*` state roots for a parent-pid match.
   ```ts
   // Source: extensions/openai-apps/src/runtime-env.ts#L37-L94
   if !Number.isFinite(parentPid) || parentPid <= 1
     return null
   candidateStateDirs := readdir(homeDir)
     .filter(entry => entry === ".openclaw" || entry.startsWith(".openclaw-"))
     .map(entry => path.join(homeDir, entry))
   for stateDir of candidateStateDirs
     for agentId of readdir(path.join(stateDir, "agents"))
       for sessionEntry of readdir(path.join(stateDir, "agents", agentId, "sessions"))
         if !sessionEntry.endsWith(".jsonl.lock")
           continue
         lockPid := await readLockPid(lockPath)
         if lockPid === parentPid
           return {
             stateDir,
             agentDir: path.join(agentsDir, agentId, "agent"),
           }
   return null
   ```
3. Fall back to the most recently updated `sessions.json` when no lock match exists.
   ```ts
   // Source: extensions/openai-apps/src/runtime-env.ts#L96-L150
   candidateStateDirs := readdir(homeDir)
     .filter(entry => entry === ".openclaw" || entry.startsWith(".openclaw-"))
     .map(entry => path.join(homeDir, entry))
   bestMatch := null
   for stateDir of candidateStateDirs
     for agentId of readdir(path.join(stateDir, "agents"))
       sessionsIndexPath := path.join(stateDir, "agents", agentId, "sessions", "sessions.json")
       updatedAt := (await stat(sessionsIndexPath)).mtimeMs
       if !bestMatch || updatedAt > bestMatch.updatedAt
         bestMatch := { stateDir, agentDir: path.join(agentsDir, agentId, "agent"), updatedAt }
   return bestMatch ? { stateDir: bestMatch.stateDir, agentDir: bestMatch.agentDir } : null
   ```

State transitions / outputs:

- Input: incomplete explicit env plus filesystem-visible OpenClaw state roots
- Output: optional `lockContext` or `recentSessionContext`

Branch points:

- Invalid `parentPid` disables the lock-based path.
- `lockContext` wins over `recentSessionContext`.
- Filesystem read failures are swallowed and treated as “no candidate here”.

External boundaries:

- Filesystem reads under `$HOME/.openclaw*`

### Phase 3: Materialize the resolved env and downstream state paths

Trigger / entry condition:

- All candidate sources for runtime context have been collected.

Entrypoints:

- `extensions/openai-apps/src/runtime-env.ts:resolveOpenaiAppsRuntimeEnv`
- `extensions/openai-apps/src/server.ts:loadRawConfig`
- `extensions/openai-apps/src/state-paths.ts:resolveChatgptAppsStatePaths`

Ordered call path:

1. Apply the env precedence order and write the resolved values back into `nextEnv`.
   ```ts
   // Source: extensions/openai-apps/src/runtime-env.ts#L175-L191
   resolvedStateDir :=
     explicitStateDir ??
     stateDirFromAgent ??
     configDir ??
     lockContext?.stateDir ??
     recentSessionContext?.stateDir ??
     path.join(homeDir, ".openclaw")
   resolvedAgentDir := explicitAgentDir ?? lockContext?.agentDir ?? recentSessionContext?.agentDir
   resolvedConfigPath := explicitConfigPath ?? path.join(resolvedStateDir, "openclaw.json")
   nextEnv.OPENCLAW_STATE_DIR = resolvedStateDir
   nextEnv.OPENCLAW_CONFIG_PATH = resolvedConfigPath
   if resolvedAgentDir
     nextEnv.OPENCLAW_AGENT_DIR = resolvedAgentDir
   return nextEnv
   ```
2. Load the bundle config from the resolved config path, defaulting to `{}` on missing file.
   ```ts
   // Source: extensions/openai-apps/src/server.ts#L19-L40
   configPath := resolveConfigPath(runtimeEnv)
   try
     return JSON.parse(await readFile(configPath, "utf8"))
   catch error
     if error.code === "ENOENT"
       return {}
     throw error
   ```
3. Derive the runtime-owned state files that downstream flows consume.
   ```ts
   // Source: extensions/openai-apps/src/state-paths.ts#L14-L42
   rootDir := path.join(resolveBundleStateDir(runtimeEnv), "plugin-runtimes", CHATGPT_APPS_RUNTIME_ID)
   return {
     rootDir,
     codexHomeDir: path.join(rootDir, "codex-home"),
     snapshotPath: path.join(rootDir, "connectors.snapshot.json"),
     derivedConfigPath: path.join(rootDir, "codex-apps.config.json"),
     refreshDebugPath: path.join(rootDir, "refresh-debug.json"),
   }
   ```

State transitions / outputs:

- Input: explicit env candidates, inferred runtime context, and `HOME`
- Output: fully resolved runtime env plus stable bundle state paths

Branch points:

- `OPENCLAW_CONFIG_PATH` outranks all inferred config locations.
- `resolveBundleStateDir(...)` in `state-paths.ts` prefers explicit `OPENCLAW_STATE_DIR`, then trims `OPENCLAW_AGENT_DIR`, then falls back to `resolveStateDir(env)`.

External boundaries:

- Filesystem read of `openclaw.json`

## State

### Core state / ordering risks

- `explicitStateDir` / `explicitConfigPath` / `explicitAgentDir`: captured first in `resolveOpenaiAppsRuntimeEnv(...)`, so precedence is fixed before any filesystem scan starts.
- `lockContext`: initialized before `recentSessionContext`, and `recentSessionContext` is skipped entirely when a lock match exists.
- `resolvedStateDir`: derived from explicit values, agent trimming, config directory, lock context, recent session, then default `.openclaw`; this ordering decides every downstream file path.
- `resolvedAgentDir`: may remain unset even when `resolvedStateDir` exists, so downstream auth flows must tolerate a missing agent dir.
- `rootDir`: first consumed by `resolveChatgptAppsStatePaths(...)` after env resolution; if env inference is wrong, every persisted snapshot/debug path is wrong too.

### Runtime controls (or `None identified`)

| Name                         | Kind | Where Read                                                                                            | Effect on Flow                                                                      |
| ---------------------------- | ---- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `OPENCLAW_STATE_DIR`         | env  | `extensions/openai-apps/src/runtime-env.ts#L156`, `extensions/openai-apps/src/state-paths.ts#L15-L17` | Hard-pins the state root and bypasses most inference.                               |
| `OPENCLAW_CONFIG_PATH`       | env  | `extensions/openai-apps/src/runtime-env.ts#L157`, `extensions/openai-apps/src/server.ts#L19-L27`      | Hard-pins the config file path and contributes `configDir` for state fallback.      |
| `OPENCLAW_AGENT_DIR`         | env  | `extensions/openai-apps/src/runtime-env.ts#L158`, `extensions/openai-apps/src/state-paths.ts#L19-L27` | Supplies an agent path that can be trimmed back to a state root.                    |
| `HOME`                       | env  | `extensions/openai-apps/src/runtime-env.ts#L165`, `extensions/openai-apps/src/server.ts#L25-L27`      | Defines where `.openclaw*` state roots are searched and the final default fallback. |
| `OPENCLAW_OPENAI_APPS_DEBUG` | env  | `extensions/openai-apps/src/server.ts#L8-L13`                                                         | Enables bootstrap debug logs after runtime env resolution.                          |

### Notable gates

- `explicitStateDir && explicitConfigPath && explicitAgentDir`: skips all inference work (`extensions/openai-apps/src/runtime-env.ts#L160-L163`).
- `Number.isFinite(parentPid) && parentPid > 1`: required before lock-based runtime matching runs (`extensions/openai-apps/src/runtime-env.ts#L41-L43`).
- `lockContext === null`: gates whether the recent-session fallback is attempted (`extensions/openai-apps/src/runtime-env.ts#L172-L173`).
- `ENOENT` in `loadRawConfig(...)`: converts a missing config file into `{}` instead of process failure (`extensions/openai-apps/src/server.ts#L32-L38`).

## Sequence diagram

```
+----------------------+
| bundle main()        |
+----------------------+
          |
          v
+----------------------+
| capture explicit env |
+----------------------+
    | full tuple     | missing pieces
    v                v
+--------------+  +----------------------+
| return env   |  | scan .openclaw* for  |
| unchanged    |  | lock/session context |
+--------------+  +----------------------+
                         |
                         v
               +----------------------+
               | apply precedence and |
               | write resolved env   |
               +----------------------+
                         |
                         v
               +----------------------+
               | load config and      |
               | derive state paths   |
               +----------------------+
```

## Observability

Metrics:

- None identified.

Logs:

- `extensions/openai-apps/src/server.ts#L8-L13` writes bootstrap debug lines to stderr when `OPENCLAW_OPENAI_APPS_DEBUG=1`.
- Runtime-env inference itself does not emit dedicated logs.

## Related docs

- `extensions/openai-apps/docs/flows/ref.openai-apps-list-tools.md`
- `extensions/openai-apps/docs/flows/ref.openai-apps-projected-auth.md`

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-30: Created the runtime environment flow doc (019d3ffc-456e-7500-84dc-309b365ada15 - 966651ecb7)
- 2026-03-30: Renamed the flow doc to `ref.openai-apps-runtime-env.md` and updated startup references. (019d4105-802e-7bd0-be7e-850070d63c37 - d78a1f3059)
