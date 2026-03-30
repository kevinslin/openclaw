# OpenAI Apps Connector Record Derivation Flow

Last updated: 2026-03-30

## Purpose

This flow documents how raw `app/list` results become persisted connector records that later drive tool publication and invocation routing. It answers how connector ids are normalized, how collisions are resolved, which internal apps are excluded, and what invariants downstream consumers rely on.

## Entry points

- `extensions/openai-apps/src/connector-record.ts`: canonical id derivation, collision handling, record shaping, exclusion, and validation
- `extensions/openai-apps/src/refresh-snapshot.ts`: snapshot refresh path that calls `deriveConnectorRecordsFromApps(...)`
- `extensions/openai-apps/src/mcp-bridge.ts`: downstream publication path that consumes `shouldExcludeConnectorId(...)` and `assertValidPersistedConnectorRecord(...)`

## Call path

### Phase 1: Derive canonical connector ids from raw apps

Trigger / entry condition:

- Snapshot refresh has already collected `AppInfo[]` from `app/list`.

Entrypoints:

- `extensions/openai-apps/src/refresh-snapshot.ts:ensureFreshSnapshot`
- `extensions/openai-apps/src/connector-record.ts:deriveConnectorRecordsFromApps`
- `extensions/openai-apps/src/connector-record.ts:deriveCanonicalConnectorId`

Ordered call path:

1. Feed raw `capture.apps` into connector derivation during snapshot construction.
   ```ts
   // Source: extensions/openai-apps/src/refresh-snapshot.ts#L181-L190
   nextSnapshot := {
     ...,
     connectors: deriveConnectorRecordsFromApps(capture.apps),
   }
   ```
2. Normalize each raw app into a canonical connector id candidate.
   ```ts
   // Source: extensions/openai-apps/src/connector-record.ts#L62-L88
   if !looksLikeOpaqueAppId(app.id)
     normalizedId := normalizeConnectorKey(app.id)
     if normalizedId
       return normalizedId
   normalizedName := normalizeConnectorKey(app.name)
   if normalizedName
     return normalizedName
   for displayName of app.pluginDisplayNames
     normalizedDisplayName := normalizeConnectorKey(displayName)
     if normalizedDisplayName
       return normalizedDisplayName
   normalizedOpaqueId := normalizeConnectorKey(app.id).replace(/^(connector|asdk_app)_/, "")
   if normalizedOpaqueId
     return `app_${normalizedOpaqueId}`
   throw Error(`Could not derive canonical connector id for app: ${app.id}`)
   ```
3. Capture the canonical id next to the original app and stable input order index.
   ```ts
   // Source: extensions/openai-apps/src/connector-record.ts#L138-L143
   appsWithCanonicalId := apps.map((app, index) => ({
     app,
     index,
     canonicalConnectorId: deriveCanonicalConnectorId(app),
   }))
   ```

State transitions / outputs:

- Input: raw `AppInfo[]`
- Output: `appsWithCanonicalId[]`

Branch points:

- Non-opaque app ids beat names and display names.
- Fully opaque ids fall back to normalized name/display-name, then to `app_${opaqueSuffix}`.
- Failure to derive any connector id is fatal.

External boundaries:

- None identified

### Phase 2: Resolve canonical-id collisions into unique connector ids

Trigger / entry condition:

- Multiple apps may now share the same `canonicalConnectorId`.

Entrypoints:

- `extensions/openai-apps/src/connector-record.ts:deriveConnectorRecordsFromApps`
- `extensions/openai-apps/src/connector-record.ts:deriveConnectorCollisionSuffix`

Ordered call path:

1. Group apps by canonical id and prepare stable collision ordering.

   ```ts
   // Source: extensions/openai-apps/src/connector-record.ts#L144-L168
   entriesByCanonicalId := new Map
   for entry of appsWithCanonicalId
     group := entriesByCanonicalId.get(entry.canonicalConnectorId)
     if group
       group.push(entry)
     else
       entriesByCanonicalId.set(entry.canonicalConnectorId, [entry])

   collisionGroup := [...group].sort((left, right) => {
     appIdComparison := left.app.id.localeCompare(right.app.id)
     if appIdComparison !== 0
       return appIdComparison
     return left.index - right.index
   })
   ```

2. Keep the first app on the plain canonical id and suffix later collisions from app id.
   ```ts
   // Source: extensions/openai-apps/src/connector-record.ts#L90-L97
   // Source: extensions/openai-apps/src/connector-record.ts#L158-L183
   deriveConnectorCollisionSuffix(app) {
     normalizedAppId := normalizeConnectorKey(app.id)
     if !normalizedAppId
       return "app"
     withoutOpaquePrefix := normalizedAppId.replace(/^(connector|asdk_app)_/, "")
     return withoutOpaquePrefix.slice(-12) || normalizedAppId
   }
   for [position, entry] of collisionGroup.entries()
     connectorId :=
       position === 0
         ? canonicalConnectorId
         : `${canonicalConnectorId}_${deriveConnectorCollisionSuffix(entry.app)}`
     if seenConnectorIds.has(connectorId)
       throw Error(`Could not derive unique connector id from app/list for app: ${entry.app.id} (${connectorId})`)
     seenConnectorIds.add(connectorId)
     connectorIdByIndex.set(entry.index, connectorId)
   ```

State transitions / outputs:

- Input: grouped canonical ids
- Output: `connectorIdByIndex` plus globally unique connector ids

Branch points:

- First entry in each collision group keeps the unsuffixed canonical id.
- Derived suffix collisions are fatal instead of silently renaming again.

External boundaries:

- None identified

### Phase 3: Build persisted connector records

Trigger / entry condition:

- Every input app has a unique derived connector id.

Entrypoints:

- `extensions/openai-apps/src/connector-record.ts:deriveConnectorRecord`
- `extensions/openai-apps/src/connector-record.ts:deriveAppInvocationToken`
- `extensions/openai-apps/src/connector-record.ts:deriveConnectorDisplayName`
- `extensions/openai-apps/src/connector-record.ts:deriveConnectorDescription`

Ordered call path:

1. Resolve user-facing name, invocation token, and description from app metadata.
   ```ts
   // Source: extensions/openai-apps/src/connector-record.ts#L99-L136
   appName := deriveConnectorDisplayName(app, connectorId) {
     return firstNonEmpty([app.name, ...app.pluginDisplayNames]) ?? connectorId
   }
   appInvocationToken := deriveAppInvocationToken(app, connectorId) {
     for candidate of [app.name, ...app.pluginDisplayNames, connectorId]
       normalized := normalizeAppInvocationToken(candidate)
       if normalized
         return normalized
     return "app"
   }
   description := deriveConnectorDescription(app, appName) {
     lead := app.description?.trim()
     return lead && lead.length > 0 ? lead : `Use ${appName} through ChatGPT apps.`
   }
   ```
2. Build one persisted record per original app in original input order.
   ```ts
   // Source: extensions/openai-apps/src/connector-record.ts#L185-L195
   records := []
   for entry of appsWithCanonicalId
     connectorId := connectorIdByIndex.get(entry.index)
     if !connectorId
       throw Error(`Missing derived connector id for app: ${entry.app.id}`)
     records.push(deriveConnectorRecord(entry.app, connectorId))
   return records
   ```

State transitions / outputs:

- Input: unique connector ids plus original app metadata
- Output: `PersistedConnectorRecord[]`

Branch points:

- Empty/invalid candidate strings fall through to later naming sources.
- Missing `connectorIdByIndex` entries are fatal.

External boundaries:

- None identified

### Phase 4: Apply downstream exclusion and validation gates

Trigger / entry condition:

- A later flow consumes persisted connector records for publication or routing.

Entrypoints:

- `extensions/openai-apps/src/connector-record.ts:shouldExcludeConnectorId`
- `extensions/openai-apps/src/connector-record.ts:assertValidPersistedConnectorRecord`
- `extensions/openai-apps/src/mcp-bridge.ts:buildAllowedConnectorIds`
- `extensions/openai-apps/src/mcp-bridge.ts:buildToolCacheFromSnapshot`

Ordered call path:

1. Exclude internal connector ids during allowlisting.
   ```ts
   // Source: extensions/openai-apps/src/connector-record.ts#L17-L60
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L94-L116
   shouldExcludeConnectorId(connectorId) {
     if !connectorId
       return false
     return EXCLUDED_CONNECTOR_IDS.has(normalizeConnectorKey(connectorId))
   }
   if shouldExcludeConnectorId(connector.connectorId) || disabledConnectorIds.has(connector.connectorId)
     continue
   ```
2. Re-validate record invariants before the bridge publishes them.
   ```ts
   // Source: extensions/openai-apps/src/connector-record.ts#L217-L243
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L123-L139
   // Source: extensions/openai-apps/src/mcp-bridge.ts#L327-L348
   assertValidPersistedConnectorRecord(record) {
     if !record.connectorId.trim()
       throw Error("Connector snapshot record is missing connectorId")
     if record.publishedName !== `chatgpt_app_${record.connectorId}`
       throw Error(`Connector snapshot record ${record.connectorId} has mismatched publishedName: ${record.publishedName}`)
     if !record.appInvocationToken.trim()
       throw Error(`Connector snapshot record ${record.connectorId} is missing appInvocationToken`)
     if !record.description.trim()
       throw Error(`Connector snapshot record ${record.connectorId} is missing description`)
     return record
   }
   ```

State transitions / outputs:

- Input: persisted connector records
- Output: publication-safe connector records that can become MCP tools and invocation routes

Branch points:

- `collab`, `connector_openai_general_agent`, and `general_agent` are excluded even when present in the snapshot.
- Validation failures abort publication instead of degrading the record.

External boundaries:

- None identified

## State

### Core state / ordering risks

- `app.id`, `app.name`, and `pluginDisplayNames`: the source-of-truth metadata that drives both canonical id and invocation token derivation.
- `canonicalConnectorId`: initialized before collision grouping, so every later uniqueness decision is scoped to this normalized base id.
- `connectorIdByIndex`: keyed by original input index, which preserves source-order output after collision resolution.
- `publishedName`: derived from final `connectorId` and later revalidated before publication; consumers assume this invariant stays exact.
- `appInvocationToken`: first generated in `deriveConnectorRecord(...)` and later consumed by `callTool` input construction, so empty tokens must be rejected before publication.

### Runtime controls (or `None identified`)

None identified

### Notable gates

- `looksLikeOpaqueAppId(app.id)`: determines whether `app.id` can be used directly as the canonical base (`extensions/openai-apps/src/connector-record.ts#L41-L43`, `extensions/openai-apps/src/connector-record.ts#L62-L88`).
- `seenConnectorIds.has(connectorId)`: turns collision-suffix reuse into a hard failure (`extensions/openai-apps/src/connector-record.ts#L170-L181`).
- `shouldExcludeConnectorId(...)`: prevents internal app ids from surfacing as tools (`extensions/openai-apps/src/connector-record.ts#L55-L60`).
- `assertValidPersistedConnectorRecord(...)`: enforces downstream record invariants (`extensions/openai-apps/src/connector-record.ts#L217-L243`).

## Sequence diagram

```
+----------------------+
| app/list AppInfo[]   |
+----------------------+
          |
          v
+----------------------+
| derive canonical ids |
+----------------------+
          |
          v
+----------------------+
| group collisions and |
| assign unique ids    |
+----------------------+
          |
          v
+----------------------+
| build persisted      |
| connector records    |
+----------------------+
          |
          v
+----------------------+
| exclude internal ids |
| validate invariants  |
+----------------------+
          |
          v
+----------------------+
| publish tools/routes |
+----------------------+
```

## Observability

Metrics:

- None identified.

Logs:

- None identified in `connector-record.ts`; failures surface as thrown errors to caller flows.

## Related docs

- `extensions/openai-apps/docs/flows/ref.openai-apps-list-tools.md`
- `extensions/openai-apps/docs/flows/ref.openai-apps-call-tool.md`

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-30: Created the connector-record derivation flow doc (019d3ffc-456e-7500-84dc-309b365ada15 - 966651ecb7)
