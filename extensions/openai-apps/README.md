# OpenAI Apps

Bundle-owned MCP bridge for exposing ChatGPT apps inside OpenClaw.

## What It Does

This bundle:

- publishes ChatGPT app tools into OpenClaw as MCP tools
- uses `app/list` as the authoritative app inventory
- reads OpenClaw-rooted `openai-codex` auth and projects it into the app-server when needed
- caches connector inventory in the plugin runtime state directory and refreshes it on demand

The bundle owns app exposure and app-specific config. It does not require changes under `src/`.

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

You can combine wildcard enablement with explicit disables if needed:

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

The ChatGPT apps endpoint is internal to the bundle and is no longer configurable.
