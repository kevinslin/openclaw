# OpenAI Apps

Bundle-owned MCP bridge for exposing ChatGPT apps inside OpenClaw.

## What It Does

This bundle:

- publishes one local MCP tool per enabled ChatGPT app connector
- uses `codex app-server` as the single authority for both tool publication and invocation
- reads OpenClaw-rooted `openai-codex` auth and projects it into the spawned app-server session
- reuses one bundle-owned app-server home at `plugin-runtimes/openai-apps/codex-home` for both snapshot refresh and tool invocation
- caches canonical connector records derived from `app/list` in the plugin runtime state directory and refreshes them on demand

Published tool names use the `chatgpt_app_<connectorId>` namespace. Each tool accepts a single natural-language `request` string and executes the app on a fresh app-server thread.

The bundle owns app exposure and app-specific config. It does not require changes under repo-root `src/`.

## Install From Bundle

`openai-apps` is a bundled plugin in this repo. If you are running from this source tree, there is no separate package install step.

Enable it in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "openai": {
        "enabled": true
      },
      "openai-apps": {
        "enabled": true
      }
    }
  }
}
```

Then restart the gateway.

Notes:

- `openai` should stay enabled because the bundle relies on OpenClaw-managed `openai-codex` auth.
- `openai-apps` owns the apps config described below.

## Configuration

All bundle config lives under `plugins.entries.openai-apps.config`.

Example with one explicitly enabled connector:

```json
{
  "plugins": {
    "entries": {
      "openai": {
        "enabled": true
      },
      "openai-apps": {
        "enabled": true,
        "config": {
          "enabled": true,
          "allow_destructive_actions": "never",
          "connectors": {
            "gmail": {
              "enabled": true
            }
          }
        }
      }
    }
  }
}
```

### Wildcard Configuration

To enable all accessible ChatGPT apps, use `*`:

```json
{
  "plugins": {
    "entries": {
      "openai": {
        "enabled": true
      },
      "openai-apps": {
        "enabled": true,
        "config": {
          "enabled": true,
          "allow_destructive_actions": "never",
          "connectors": {
            "*": {
              "enabled": true
            }
          }
        }
      }
    }
  }
}
```

You can combine wildcard enablement with explicit disables:

```json
{
  "plugins": {
    "entries": {
      "openai-apps": {
        "enabled": true,
        "config": {
          "enabled": true,
          "allow_destructive_actions": "never",
          "connectors": {
            "*": {
              "enabled": true
            },
            "slack": {
              "enabled": false
            }
          }
        }
      }
    }
  }
}
```

## Config Reference

- `enabled`: Turns the bundle-owned ChatGPT apps bridge on or off.
- `allow_destructive_actions`: Controls destructive app-action elicitations. Use `"always"` to auto-accept, `"on-request"` to prompt the MCP caller with accept or decline, or `"never"` to auto-decline. Defaults to `"never"`.
- `connectors`: Per-app enablement map. Use explicit connector ids like `gmail`, `linear`, or `google_calendar`.
- `connectors["*"]`: Enables all accessible ChatGPT apps, with explicit connector entries able to disable individual apps.
- `appServer.command` / `appServer.args`: Override how the bundle launches `codex app-server`.

The ChatGPT apps endpoint is internal to the bundle and is not configurable.

## Runtime State

The bundle keeps its runtime state under `plugin-runtimes/openai-apps/`.

- `codex-home/`: shared `CODEX_HOME` used for both snapshot refresh and per-tool invocation
- `connectors.snapshot.json`: persisted connector records derived from `app/list`
- `refresh-debug.json`: last refresh result/debug payload written by the bundle

Both refresh and invocation launch `codex app-server` with the same bundle-owned `codex-home`. Invocation still starts a fresh app-server thread for every tool call, but it now rewrites the derived `apps` config into the app-server-managed config inside that shared home before starting the turn instead of using a temporary invocation-only home.

## Snapshot Shape

The persisted snapshot under `plugin-runtimes/openai-apps/connectors.snapshot.json` stores
connector-level records derived from `app/list`. It does not persist raw
`inventory` or any status payload.

Example:

```json
{
  "version": 2,
  "fetchedAt": "2026-03-30T18:00:00.000Z",
  "projectedAt": "2026-03-30T18:00:00.000Z",
  "accountId": "acct_123",
  "authIdentityKey": "user@example.com",
  "connectors": [
    {
      "connectorId": "gmail",
      "appId": "asdk_app_gmail",
      "appName": "Gmail",
      "publishedName": "chatgpt_app_gmail",
      "appInvocationToken": "gmail",
      "description": "Read and send Gmail messages.",
      "pluginDisplayNames": ["Gmail"],
      "isAccessible": true,
      "isEnabled": true
    }
  ]
}
```

## Integration Tests

Run the integration suite through the extension harness:

```bash
./extensions/openai-apps/integ/test-chatapps-integ.sh simple
./extensions/openai-apps/integ/test-chatapps-integ.sh full
./extensions/openai-apps/integ/test-chatapps-integ.sh write
```

Mode coverage:

- `simple`: runs `list tools` plus the Gmail call.
- `full`: runs `list tools`, Gmail, Linear, and Google Calendar.
- `write`: runs `list tools` plus Google Calendar write-policy checks for `allowDestructiveActions=always` and `allowDestructiveActions=never`.

The harness writes artifacts under `/tmp/claw-chat-apps/`.

### Harness Setup

The live harness is intentionally isolated from your normal OpenClaw profile.
It always runs under the dedicated profile `chatapps-integ` with state rooted
at `~/.openclaw-chatapps-integ/`.

Setup details:

- The harness creates or rewrites the `chatapps-integ` config before each run.
- It uses a dedicated workspace at `~/.openclaw-chatapps-integ/workspace`.
- That workspace is deleted and recreated for each run.
- The profile forces `plugins.slots.memory = "none"`.
- The profile disables `agents.defaults.memorySearch`.
- The profile disables the internal `session-memory` hook.
- The profile sets `agents.defaults.skipBootstrap = true` so the workspace stays empty instead of being seeded with bootstrap files like `SOUL.md`, `USER.md`, or `BOOTSTRAP.md`.

This isolation matters because the connector smoke tests should exercise the
ChatGPT app invocation path, not whatever memory files or bootstrap context may
exist in a developer's normal workspace.

### Auth Requirements

The harness expects reusable `openai-codex` OAuth state to already exist in at
least one local OpenClaw profile. Before running the live suite:

```bash
openclaw models auth login --provider openai-codex
```

The harness will copy that login state into the `chatapps-integ` profile when
possible. If no reusable login is found, the run fails fast with an auth setup
error.

### Useful Notes

- Override the gateway port with `OPENCLAW_GATEWAY_PORT=<port>` if needed.
- The harness starts a fresh dev gateway and TUI session for each live run.
- The final artifacts include per-leg summaries plus a Showboat demo doc under
  `/tmp/claw-chat-apps/`.

## Appendix

### Calls to App Server

Setting the developer message

```js
[
      {
        "approvalPolicy": "never",
        "developerInstructions": "You are servicing one OpenClaw connector tool call for Gmail.  Use the app mentioned in the user input instead of browsing or relying on unrelated tools.  Do not use browser, shell, file, web, image, memory, or unrelated tools.  Do not ask follow-up questions.  Do not fabricate success.  Return only JSON matching the schema {"status":"success|failure","result":"string","error":"string"}.", "ephemeral": false,
        "experimentalRawEvents": false,
        "persistExtendedHistory": true,
      },
  ]
```

Example call

```js
[
  {
    text: "$gmail Summarize my recent emails",
    text_elements: [],
    type: "text",
  },
  {
    name: "Gmail",
    path: "app://asdk_app_gmail",
    type: "mention",
  },
];
```
