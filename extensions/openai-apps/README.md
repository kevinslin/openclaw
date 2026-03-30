# OpenAI Apps

Bundle-owned MCP bridge for exposing ChatGPT apps inside OpenClaw.

## What It Does

This bundle:

- publishes one local MCP tool per enabled ChatGPT app connector
- uses `codex app-server` as the single authority for both tool publication and invocation
- reads OpenClaw-rooted `openai-codex` auth and projects it into the spawned app-server session
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
- `connectors`: Per-app enablement map. Use explicit connector ids like `gmail`, `linear`, or `google_calendar`.
- `connectors["*"]`: Enables all accessible ChatGPT apps, with explicit connector entries able to disable individual apps.
- `appServer.command` / `appServer.args`: Override how the bundle launches `codex app-server`.
- `linking.enabled`: Enables the auth-link polling flow for apps that require an interactive link step.
- `linking.waitTimeoutMs` / `linking.pollIntervalMs`: Tune how long the bundle waits for that link flow to complete.

The ChatGPT apps endpoint is internal to the bundle and is not configurable.

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
  "configHash": "config-hash",
  "baseUrlHash": "base-hash",
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

Run the integration suite through the repo-level wrapper in `scripts/`:

```bash
./scripts/test-chatapps-integ.sh simple
./scripts/test-chatapps-integ.sh full
```

Mode coverage:

- `simple`: runs `list tools` plus the Gmail call.
- `full`: runs `list tools`, Gmail, Linear, and Google Calendar.

The wrapper delegates to the `openai-apps` integration harness and writes
artifacts under `/tmp/claw-chat-apps/`.

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
