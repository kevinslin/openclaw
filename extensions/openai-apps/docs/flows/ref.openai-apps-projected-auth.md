# OpenAI Apps Projected Auth Flow

Last updated: 2026-03-30

## Purpose

This flow documents how the `openai-apps` bundle resolves ChatGPT-compatible auth from the OpenClaw `openai-codex` OAuth store. It answers how the bundle picks a profile, when it refreshes tokens, how it derives a stable identity, and why failures split into `missing-auth`, `missing-account-id`, and `error`.

## Entry points

- `extensions/openai-apps/src/auth-projector.ts`: projected auth selection, refresh, persistence, and result shaping
- `extensions/openai-apps/src/openai-codex-auth-identity.ts`: JWT-based identity derivation used by the projector

## Call path

### Phase 1: Select an OAuth profile from the auth store

Trigger / entry condition:

- A bundle flow such as snapshot refresh or tool invocation calls `resolveChatgptAppsProjectedAuth(...)`.

Entrypoints:

- `extensions/openai-apps/src/auth-projector.ts:resolveChatgptAppsProjectedAuth`
- `extensions/openai-apps/src/auth-projector.ts:resolveStoredOauthCredential`

Ordered call path:

1. Open the auth profile store without allowing a keychain prompt.
   ```ts
   // Source: extensions/openai-apps/src/auth-projector.ts#L40-L87
   store := ensureAuthProfileStore(params.agentDir, {
     allowKeychainPrompt: false,
   })
   defaultProfileId :=
     store.profiles?.["openai-codex:default"]?.provider === "openai-codex"
       ? "openai-codex:default"
       : null
   profileId :=
     defaultProfileId ??
     Object.entries(store.profiles ?? {}).find(([_, credential]) =>
       credential?.type === "oauth" && credential.provider === "openai-codex"
     )?.[0] ??
     null
   if !profileId
     return { profileId: null, credential: null }
   ```
2. Normalize the stored credential and reject unusable non-oauth or access-less profiles.
   ```ts
   // Source: extensions/openai-apps/src/auth-projector.ts#L65-L87
   credential := store.profiles[profileId]
   if credential?.type !== "oauth"
     return { profileId, credential: null }
   accessToken := normalizeOptionalString(credential.access)
   if !accessToken
     return { profileId, credential: null }
   return {
     profileId,
     credential: {
       ...credential,
       access: accessToken,
       accountId: normalizeOptionalString(credential.accountId),
       email: normalizeOptionalString(credential.email),
       displayName: normalizeOptionalString(credential.displayName),
     },
   }
   ```
3. Convert missing profile or missing usable credential into `missing-auth`.
   ```ts
   // Source: extensions/openai-apps/src/auth-projector.ts#L147-L163
   initial := resolveStoredOauthCredential(params)
   profileId := initial.profileId
   if !profileId
     return { status: "missing-auth", message: "OpenAI Codex OAuth is not configured in OpenClaw." }
   storedCredential := initial.credential
   if !storedCredential
     return { status: "missing-auth", message: "OpenAI Codex OAuth is not configured in OpenClaw." }
   ```

State transitions / outputs:

- Input: `agentDir`-scoped auth store and its profiles
- Output: normalized `OAuthCredential` plus `profileId`, or early `missing-auth`

Branch points:

- `openai-codex:default` wins over any other matching provider profile.
- A non-oauth profile or empty `access` field is treated the same as missing auth.

External boundaries:

- Auth profile store access through `ensureAuthProfileStore(...)`

### Phase 2: Refresh the OAuth credential when it is near expiry

Trigger / entry condition:

- A usable stored OAuth credential exists.

Entrypoints:

- `extensions/openai-apps/src/auth-projector.ts:shouldRefreshOauthCredential`
- `extensions/openai-apps/src/auth-projector.ts:resolveFreshOauthCredential`

Ordered call path:

1. Decide whether refresh is needed from `refresh`, `access`, and `expires`.
   ```ts
   // Source: extensions/openai-apps/src/auth-projector.ts#L89-L102
   refreshToken := normalizeOptionalString(credential.refresh)
   if !refreshToken
     return false
   if !normalizeOptionalString(credential.access)
     return true
   expiresAt := typeof credential.expires === "number" ? credential.expires : null
   if !Number.isFinite(expiresAt)
     return false
   return expiresAt <= Date.now() + 60_000
   ```
2. Skip refresh when the credential is still considered fresh enough.
   ```ts
   // Source: extensions/openai-apps/src/auth-projector.ts#L104-L116
   if !shouldRefreshOauthCredential(params.credential)
     return params.credential
   refreshToken := normalizeOptionalString(params.credential.refresh)
   if !refreshToken
     return params.credential
   ```
3. Refresh through the OAuth endpoint and persist the updated profile under lock.
   ```ts
   // Source: extensions/openai-apps/src/auth-projector.ts#L118-L140
   ensureGlobalUndiciEnvProxyDispatcher()
   refreshed := await refreshOpenAICodexToken(refreshToken)
   nextCredential := {
     ...params.credential,
     type: "oauth",
     provider: "openai-codex",
     access: refreshed.access,
     refresh: normalizeOptionalString(refreshed.refresh) ?? refreshToken,
     expires: refreshed.expires,
     accountId: normalizeOptionalString(refreshed.accountId) ?? params.credential.accountId,
     email: params.credential.email,
     displayName: params.credential.displayName,
   }
   await upsertAuthProfileWithLock({
     agentDir: params.agentDir,
     profileId: params.profileId,
     credential: nextCredential,
   })
   return nextCredential
   catch
     return params.credential
   ```

State transitions / outputs:

- Input: normalized stored OAuth credential
- Output: refreshed-and-persisted credential or original credential on refresh skip/failure

Branch points:

- Missing `refresh` means “never refresh”.
- Non-finite `expires` means “do not proactively refresh”.
- Refresh failures are swallowed and return the original credential instead of failing the whole flow.

External boundaries:

- Network call through `refreshOpenAICodexToken(...)`
- Auth store write through `upsertAuthProfileWithLock(...)`

### Phase 3: Derive identity and shape the projected auth union

Trigger / entry condition:

- The flow has a resolved credential, whether refreshed or original.

Entrypoints:

- `extensions/openai-apps/src/auth-projector.ts:resolveChatgptAppsProjectedAuth`
- `extensions/openai-apps/src/openai-codex-auth-identity.ts:resolveCodexAuthIdentity`

Ordered call path:

1. Require a non-empty `access` token even after refresh handling.
   ```ts
   // Source: extensions/openai-apps/src/auth-projector.ts#L165-L175
   resolved := await resolveFreshOauthCredential({ agentDir: params.agentDir, profileId, credential: storedCredential })
   if !normalizeOptionalString(resolved.access)
     return { status: "missing-auth", message: "OpenAI Codex OAuth is not configured in OpenClaw." }
   accessToken := resolved.access
   ```
2. Derive identity from JWT claims, preferring email and then a stable subject.
   ```ts
   // Source: extensions/openai-apps/src/openai-codex-auth-identity.ts#L22-L78
   payload := decodeCodexJwtPayload(accessToken)
   email :=
     normalizeNonEmptyString(payload?.["https://api.openai.com/profile"]?.email) ??
     normalizeNonEmptyString(params.email)
   if email
     return { email, profileName: email }
   stableSubject := resolveCodexStableSubject(payload) {
     accountUserId := normalizeNonEmptyString(auth?.chatgpt_account_user_id)
     if accountUserId
       return accountUserId
     userId := normalizeNonEmptyString(auth?.chatgpt_user_id) ?? normalizeNonEmptyString(auth?.user_id)
     if userId
       return userId
     if iss && sub
       return `${iss}|${sub}`
     return sub
   }
   if !stableSubject
     return {}
   return { profileName: `id-${Buffer.from(stableSubject).toString("base64url")}` }
   ```
3. Require `accountId` and return the final discriminated union.
   ```ts
   // Source: extensions/openai-apps/src/auth-projector.ts#L177-L209
   identity := resolveCodexAuthIdentity({
     accessToken,
     email: normalizeOptionalString(resolved.email),
   })
   accountId := normalizeOptionalString(resolved.accountId)
   if !accountId
     return {
       status: "missing-account-id",
       message: "OpenAI Codex OAuth is present, but the credential does not expose a ChatGPT account id. Re-login with openai-codex before enabling ChatGPT apps.",
       accessToken,
       identity,
       profileId,
     }
   return {
     status: "ok",
     accessToken,
     accountId,
     planType: null,
     identity,
     profileId,
   }
   catch error
     return {
       status: "error",
       message: error instanceof Error ? error.message : String(error),
     }
   ```

State transitions / outputs:

- Input: resolved credential and optional JWT identity claims
- Output: `ChatgptAppsResolvedAuth`

Branch points:

- Missing `accountId` is a distinct failure mode from missing auth.
- JWT decode failure still allows an empty identity object if no stable subject can be derived.
- Unexpected exceptions are folded into `status: "error"`.

External boundaries:

- None identified beyond prior auth-store/network steps

## State

### Core state / ordering risks

- `profileId`: selected before any refresh attempt; refresh writes back into the same profile id that was chosen during store scan.
- `credential.access`: normalized first in `resolveStoredOauthCredential(...)`, then checked again after refresh resolution so a failed refresh cannot smuggle an empty access token into downstream consumers.
- `refreshToken` / `expires`: captured before the network call and determine whether refresh can happen at all.
- `identity`: derived after `accessToken` is finalized, so it always reflects the token that downstream flows will use.
- `accountId`: initialized after identity derivation and is the first consumer-side gate that splits `ok` from `missing-account-id`.

### Runtime controls (or `None identified`)

| Name                                    | Kind                 | Where Read                                                                                                       | Effect on Flow                                                             |
| --------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `agentDir`                              | runtime input        | `extensions/openai-apps/src/auth-projector.ts#L44-L46`, `extensions/openai-apps/src/auth-projector.ts#L132-L136` | Selects which auth profile store is read and later updated.                |
| `openai-codex:default` profile presence | persisted auth state | `extensions/openai-apps/src/auth-projector.ts#L47-L60`                                                           | Gives the default profile priority over other matching oauth profiles.     |
| OAuth credential `refresh` / `expires`  | persisted auth state | `extensions/openai-apps/src/auth-projector.ts#L89-L102`                                                          | Controls whether the flow attempts a token refresh before projecting auth. |

### Notable gates

- `profileId !== null` and `storedCredential !== null`: together gate `missing-auth` (`extensions/openai-apps/src/auth-projector.ts#L147-L163`).
- `shouldRefreshOauthCredential(...)`: determines whether a network refresh is attempted (`extensions/openai-apps/src/auth-projector.ts#L89-L102`).
- `normalizeOptionalString(resolved.access)`: a final access-token gate after refresh handling (`extensions/openai-apps/src/auth-projector.ts#L170-L175`).
- `normalizeOptionalString(resolved.accountId)`: distinguishes `missing-account-id` from `ok` (`extensions/openai-apps/src/auth-projector.ts#L182-L193`).

## Sequence diagram

```
+----------------------+
| resolve projected    |
| auth                 |
+----------------------+
          |
          v
+----------------------+
| scan auth store for  |
| openai-codex profile |
+----------------------+
    | none/invalid    | usable
    v                 v
+---------------+  +----------------------+
| missing-auth  |  | refresh if needed    |
+---------------+  +----------------------+
                           |
                           v
                 +----------------------+
                 | derive identity from |
                 | JWT / stored email   |
                 +----------------------+
                           |
                +----------+----------+
                | accountId          |
                | missing            | present
                v                    v
      +-------------------+   +----------------+
      | missing-account-id|   | ok             |
      +-------------------+   +----------------+
```

## Observability

Metrics:

- None identified.

Logs:

- None identified in `auth-projector.ts`; this flow returns structured status instead of logging.

## Related docs

- `extensions/openai-apps/docs/flows/ref.openai-apps-runtime-env.md`
- `extensions/openai-apps/docs/flows/ref.openai-apps-list-tools.md`
- `extensions/openai-apps/docs/flows/ref.openai-apps-call-tool.md`

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-03-30: Created the projected auth flow doc (019d3ffc-456e-7500-84dc-309b365ada15 - 966651ecb7)
- 2026-03-30: Renamed the flow doc to `ref.openai-apps-projected-auth.md` and updated related links. (019d4105-802e-7bd0-be7e-850070d63c37 - d78a1f3059)
