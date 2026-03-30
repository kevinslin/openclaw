#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: extensions/openai-apps/integ/test-chatapps-integ.sh [simple|full]

Runs the live ChatGPT apps connector integration suite against the dev gateway,
writes artifacts to /tmp/claw-chat-apps/, generates a Showboat proof doc, and
returns 0 on success or 1 on failure.

Modes:
  simple  Verify list tools and Gmail
  full    Verify list tools, Gmail, Linear, and Google Calendar
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

MODE="${1:-full}"
case "$MODE" in
  simple | full) ;;
  *)
    usage >&2
    exit 1
    ;;
esac

ROOT_DIR="/tmp/claw-chat-apps"
LIST_TOOLS_SUMMARY_JSON="${ROOT_DIR}/list-tools-summary.json"
GMAIL_LOG="${ROOT_DIR}/gmail-tui.log"
GMAIL_SUMMARY="${ROOT_DIR}/gmail-summary.txt"
LINEAR_LOG="${ROOT_DIR}/linear-tui.log"
LINEAR_SUMMARY="${ROOT_DIR}/linear-summary.txt"
GCAL_LOG="${ROOT_DIR}/gcal-tui.log"
GCAL_SUMMARY="${ROOT_DIR}/gcal-summary.txt"
GATEWAY_LOG="${ROOT_DIR}/gateway.log"
DEMO_FILE="${ROOT_DIR}/demo-${MODE}.md"
SESSION_SUFFIX="$(date +%Y%m%d%H%M%S)"
GMAIL_SESSION="smoke-gmail-chatapps-${SESSION_SUFFIX}"
LINEAR_SESSION="smoke-linear-chatapps-${SESSION_SUFFIX}"
GCAL_SESSION="smoke-gcal-chatapps-${SESSION_SUFFIX}"

REPO_DIR="/Users/kevinlin/code/openclaw"
TRANSCRIPT_READER="/Users/kevinlin/code/kl-oai-skills/claw-conn-debug/scripts/read_tui_session.py"
INTEG_PROFILE="chatapps-integ"
INTEG_STATE_DIR="${HOME}/.openclaw-${INTEG_PROFILE}"
INTEG_CONFIG_PATH="${INTEG_STATE_DIR}/openclaw.json"
INTEG_WORKSPACE_DIR="${INTEG_STATE_DIR}/workspace"
INTEG_AGENT_ID="${INTEG_PROFILE}"
INTEG_AGENT_DIR="${INTEG_STATE_DIR}/agents/${INTEG_AGENT_ID}/agent"
INTEG_MAIN_AGENT_DIR="${INTEG_STATE_DIR}/agents/main/agent"
INTEG_AGENT_AUTH_PATH="${INTEG_AGENT_DIR}/auth-profiles.json"
INTEG_MAIN_AUTH_PATH="${INTEG_MAIN_AGENT_DIR}/auth-profiles.json"

GATEWAY_PID=""
STARTED_GATEWAY=0
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19011}"
RUN_NODE_PATH="${REPO_DIR}/scripts/run-node.mjs"
TUI_PIDS=()
INTEG_ENV=(
  OPENCLAW_PROFILE="$INTEG_PROFILE"
  OPENCLAW_STATE_DIR="$INTEG_STATE_DIR"
  OPENCLAW_CONFIG_PATH="$INTEG_CONFIG_PATH"
  OPENCLAW_WORKSPACE_DIR="$INTEG_WORKSPACE_DIR"
  OPENCLAW_AGENT_DIR="$INTEG_AGENT_DIR"
  OPENCLAW_GATEWAY_PORT="$GATEWAY_PORT"
)

terminate_process() {
  local pid="$1"
  if [[ -z "$pid" ]]; then
    return 0
  fi

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    wait "$pid" >/dev/null 2>&1 || true
    return 0
  fi

  kill "$pid" >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" >/dev/null 2>&1 || true
      return 0
    fi
    sleep 1
  done

  kill -9 "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  for pid in "${TUI_PIDS[@]:-}"; do
    terminate_process "$pid"
  done
  if [[ "$STARTED_GATEWAY" -eq 1 && -n "$GATEWAY_PID" ]]; then
    terminate_process "$GATEWAY_PID"
  fi
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "error: $*" >&2
  exit 1
}

gateway_listening() {
  python3 - "$GATEWAY_PORT" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket()
sock.settimeout(0.5)
try:
    sock.connect(("127.0.0.1", port))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()

raise SystemExit(0)
PY
}

wait_for_gateway() {
  local attempts=60
  local attempt=0
  while (( attempt < attempts )); do
    if gateway_listening; then
      if grep -q "listening on ws://127.0.0.1:${GATEWAY_PORT}" "$GATEWAY_LOG" 2>/dev/null; then
        return 0
      fi
      if grep -q "already running under launchd" "$GATEWAY_LOG" 2>/dev/null; then
        return 0
      fi
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
}

terminate_matching_dev_processes() {
  local pids=()
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(
    ps -axo pid=,command= |
      awk -v run_node="$RUN_NODE_PATH" '
        index($0, run_node) > 0 && (index($0, "--dev gateway") > 0 || index($0, "--dev tui") > 0) {
          print $1
        }
      '
  )

  if (( ${#pids[@]} > 0 )); then
    kill "${pids[@]}" >/dev/null 2>&1 || true
  fi
  sleep 1
  if (( ${#pids[@]} > 0 )); then
    kill -9 "${pids[@]}" >/dev/null 2>&1 || true
  fi
}

prepare_output_dir() {
  rm -rf "$ROOT_DIR"
  mkdir -p "$ROOT_DIR"
}

require_prereqs() {
  [[ -f "$TRANSCRIPT_READER" ]] || fail "missing transcript reader at ${TRANSCRIPT_READER}"
  (
    cd "$REPO_DIR"
    uvx showboat --help >/dev/null
  ) || fail "uvx showboat is not available"
}

auth_store_has_openai_codex_login() {
  local auth_path="$1"

  python3 - "$auth_path" <<'PY'
from pathlib import Path
import json
import sys

auth_path = Path(sys.argv[1])
if not auth_path.is_file():
    raise SystemExit(1)

try:
    raw = json.loads(auth_path.read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(1)

profiles = raw.get("profiles")
if not isinstance(profiles, dict):
    raise SystemExit(1)

for credential in profiles.values():
    if not isinstance(credential, dict):
        continue
    if credential.get("type") != "oauth":
        continue
    if credential.get("provider") != "openai-codex":
        continue
    access = credential.get("access")
    account_id = credential.get("accountId")
    if isinstance(access, str) and access.strip() and isinstance(account_id, str) and account_id.strip():
        raise SystemExit(0)

raise SystemExit(1)
PY
}

find_profile_config_source() {
  python3 - "$HOME" "$INTEG_STATE_DIR" <<'PY'
from pathlib import Path
import sys

home = Path(sys.argv[1]).expanduser()
target_state_dir = Path(sys.argv[2]).expanduser().resolve()

state_dirs = []
default_state_dir = home / ".openclaw"
if default_state_dir.is_dir() and default_state_dir.resolve() != target_state_dir:
    state_dirs.append(default_state_dir)

for candidate in sorted(home.glob(".openclaw-*")):
    if not candidate.is_dir():
        continue
    if candidate.resolve() == target_state_dir:
        continue
    state_dirs.append(candidate)

for state_dir in state_dirs:
    config_path = state_dir / "openclaw.json"
    if config_path.is_file():
        print(config_path)
        raise SystemExit(0)

raise SystemExit(1)
PY
}

find_openai_codex_auth_source() {
  python3 - "$HOME" "$INTEG_STATE_DIR" <<'PY'
from pathlib import Path
import json
import sys

home = Path(sys.argv[1]).expanduser()
target_state_dir = Path(sys.argv[2]).expanduser().resolve()

def has_reusable_openai_codex_auth(auth_path: Path) -> bool:
    if not auth_path.is_file():
        return False
    try:
        raw = json.loads(auth_path.read_text(encoding="utf-8"))
    except Exception:
        return False
    profiles = raw.get("profiles")
    if not isinstance(profiles, dict):
        return False
    for credential in profiles.values():
        if not isinstance(credential, dict):
            continue
        if credential.get("type") != "oauth":
            continue
        if credential.get("provider") != "openai-codex":
            continue
        access = credential.get("access")
        account_id = credential.get("accountId")
        if isinstance(access, str) and access.strip() and isinstance(account_id, str) and account_id.strip():
            return True
    return False

state_dirs = []
default_state_dir = home / ".openclaw"
if default_state_dir.is_dir() and default_state_dir.resolve() != target_state_dir:
    state_dirs.append(default_state_dir)

for candidate in sorted(home.glob(".openclaw-*")):
    if not candidate.is_dir():
        continue
    if candidate.resolve() == target_state_dir:
        continue
    state_dirs.append(candidate)

for state_dir in state_dirs:
    candidates = []
    main_auth = state_dir / "agents" / "main" / "agent" / "auth-profiles.json"
    if main_auth.is_file():
        candidates.append(main_auth)
    for auth_path in sorted((state_dir / "agents").glob("*/agent/auth-profiles.json")):
        if auth_path not in candidates:
            candidates.append(auth_path)
    for auth_path in candidates:
        if has_reusable_openai_codex_auth(auth_path):
            print(auth_path)
            raise SystemExit(0)

raise SystemExit(1)
PY
}

ensure_integration_profile_config() {
  mkdir -p \
    "$INTEG_STATE_DIR" \
    "$INTEG_WORKSPACE_DIR" \
    "$INTEG_AGENT_DIR" \
    "${INTEG_STATE_DIR}/agents/${INTEG_AGENT_ID}/sessions" \
    "$INTEG_MAIN_AGENT_DIR" \
    "${INTEG_STATE_DIR}/agents/main/sessions"

  if [[ ! -f "$INTEG_CONFIG_PATH" ]]; then
    local source_config=""
    source_config="$(find_profile_config_source || true)"
    if [[ -n "$source_config" ]]; then
      cp "$source_config" "$INTEG_CONFIG_PATH"
    else
      printf '{}\n' >"$INTEG_CONFIG_PATH"
    fi
  fi

  python3 - "$INTEG_CONFIG_PATH" <<'PY'
from pathlib import Path
import json
import sys

config_path = Path(sys.argv[1])

try:
    raw = json.loads(config_path.read_text(encoding="utf-8"))
except Exception:
    raw = {}

if not isinstance(raw, dict):
    raw = {}

plugins = raw.setdefault("plugins", {})
if not isinstance(plugins, dict):
    plugins = {}
    raw["plugins"] = plugins

entries = plugins.setdefault("entries", {})
if not isinstance(entries, dict):
    entries = {}
    plugins["entries"] = entries

openai_entry = entries.setdefault("openai", {})
if not isinstance(openai_entry, dict):
    openai_entry = {}
    entries["openai"] = openai_entry
openai_entry["enabled"] = True

apps_entry = entries.setdefault("openai-apps", {})
if not isinstance(apps_entry, dict):
    apps_entry = {}
    entries["openai-apps"] = apps_entry
apps_entry["enabled"] = True

apps_config = apps_entry.setdefault("config", {})
if not isinstance(apps_config, dict):
    apps_config = {}
    apps_entry["config"] = apps_config
apps_config["enabled"] = True

connectors = apps_config.setdefault("connectors", {})
if not isinstance(connectors, dict):
    connectors = {}
    apps_config["connectors"] = connectors

wildcard = connectors.setdefault("*", {})
if not isinstance(wildcard, dict):
    wildcard = {}
    connectors["*"] = wildcard
wildcard["enabled"] = True

plugins_slots = plugins.setdefault("slots", {})
if not isinstance(plugins_slots, dict):
    plugins_slots = {}
    plugins["slots"] = plugins_slots
plugins_slots["memory"] = "none"

agents = raw.setdefault("agents", {})
if not isinstance(agents, dict):
    agents = {}
    raw["agents"] = agents

defaults = agents.setdefault("defaults", {})
if not isinstance(defaults, dict):
    defaults = {}
    agents["defaults"] = defaults
defaults["workspace"] = str(config_path.parent / "workspace")
defaults["skipBootstrap"] = True

memory_search = defaults.setdefault("memorySearch", {})
if not isinstance(memory_search, dict):
    memory_search = {}
    defaults["memorySearch"] = memory_search
memory_search["enabled"] = False

hooks = raw.setdefault("hooks", {})
if not isinstance(hooks, dict):
    hooks = {}
    raw["hooks"] = hooks

internal_hooks = hooks.setdefault("internal", {})
if not isinstance(internal_hooks, dict):
    internal_hooks = {}
    hooks["internal"] = internal_hooks

hook_entries = internal_hooks.setdefault("entries", {})
if not isinstance(hook_entries, dict):
    hook_entries = {}
    internal_hooks["entries"] = hook_entries

session_memory = hook_entries.setdefault("session-memory", {})
if not isinstance(session_memory, dict):
    session_memory = {}
    hook_entries["session-memory"] = session_memory
session_memory["enabled"] = False

config_path.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
PY
}

ensure_integration_profile_openai_auth() {
  mkdir -p "$INTEG_AGENT_DIR" "$INTEG_MAIN_AGENT_DIR"

  local existing_auth=""
  if auth_store_has_openai_codex_login "$INTEG_AGENT_AUTH_PATH"; then
    existing_auth="$INTEG_AGENT_AUTH_PATH"
  elif auth_store_has_openai_codex_login "$INTEG_MAIN_AUTH_PATH"; then
    existing_auth="$INTEG_MAIN_AUTH_PATH"
  fi

  if [[ -z "$existing_auth" ]]; then
    existing_auth="$(find_openai_codex_auth_source || true)"
  fi

  if [[ -z "$existing_auth" ]]; then
    fail "No OpenClaw profile has reusable openai-codex OAuth for ChatGPT apps. Log in first with 'openclaw models auth login --provider openai-codex' in any OpenClaw profile, then rerun this integration test."
  fi

  if [[ "$existing_auth" != "$INTEG_MAIN_AUTH_PATH" ]]; then
    cp "$existing_auth" "$INTEG_MAIN_AUTH_PATH"
  fi
  if [[ "$existing_auth" != "$INTEG_AGENT_AUTH_PATH" ]]; then
    cp "$existing_auth" "$INTEG_AGENT_AUTH_PATH"
  fi

  if ! auth_store_has_openai_codex_login "$INTEG_AGENT_AUTH_PATH"; then
    fail "integration profile auth copy did not produce a reusable openai-codex login"
  fi
}

prepare_integration_profile() {
  rm -rf "$INTEG_WORKSPACE_DIR"
  mkdir -p "$INTEG_WORKSPACE_DIR"
  ensure_integration_profile_config
  ensure_integration_profile_openai_auth

  if [[ -f "${REPO_DIR}/scripts/prepare-dev-profile.mjs" ]]; then
    (
      cd "$REPO_DIR"
      env "${INTEG_ENV[@]}" node scripts/prepare-dev-profile.mjs
    )
  elif [[ ! -f "$INTEG_CONFIG_PATH" ]]; then
    fail "integration profile config missing at ${INTEG_CONFIG_PATH}"
  fi
}

start_fresh_gateway() {
  terminate_matching_dev_processes

  if gateway_listening; then
    fail "gateway port ${GATEWAY_PORT} is already in use; stop the existing listener or rerun with OPENCLAW_GATEWAY_PORT set to a free port"
  fi

  (
    cd "$REPO_DIR"
    env OPENCLAW_SKIP_CHANNELS=1 "${INTEG_ENV[@]}" \
      node scripts/run-node.mjs --dev gateway >"$GATEWAY_LOG" 2>&1 &
    echo $! >"${ROOT_DIR}/gateway.pid"
  )
  GATEWAY_PID="$(cat "${ROOT_DIR}/gateway.pid")"
  STARTED_GATEWAY=1

  if ! wait_for_gateway; then
    [[ -f "$GATEWAY_LOG" ]] && cat "$GATEWAY_LOG" >&2
    fail "dev gateway did not become ready"
  fi
}

capture_list_tools_summary() {
  local required_tools_json="$1"

  (
    cd "$REPO_DIR"
    env "${INTEG_ENV[@]}" REQUIRED_PUBLISHED_TOOLS_JSON="$required_tools_json" \
      node --input-type=module --import tsx <<'EOF' >"$LIST_TOOLS_SUMMARY_JSON"
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { shouldExcludeConnectorId } from "./extensions/openai-apps/src/connector-record.js";
import { resolveChatgptAppsConfig } from "./extensions/openai-apps/src/config.js";
import { resolveChatgptAppsStatePaths } from "./extensions/openai-apps/src/state-paths.js";

const requiredPublishedTools = JSON.parse(process.env.REQUIRED_PUBLISHED_TOOLS_JSON ?? "[]");

function normalizeConnectorKey(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function buildConnectorConfigState(configuredConnectors) {
  let wildcardEnabled = false;
  const enabledConnectorIds = new Set();
  const disabledConnectorIds = new Set();

  for (const [connectorId, connector] of Object.entries(configuredConnectors)) {
    const trimmedId = connectorId.trim();
    if (!trimmedId) {
      continue;
    }
    if (trimmedId === "*") {
      wildcardEnabled = connector?.enabled === true;
      continue;
    }

    const normalized = normalizeConnectorKey(trimmedId);
    if (!normalized) {
      continue;
    }

    if (connector?.enabled) {
      enabledConnectorIds.add(normalized);
      continue;
    }

    disabledConnectorIds.add(normalized);
  }

  return { wildcardEnabled, enabledConnectorIds, disabledConnectorIds };
}

function buildExpectedPublishedTools(connectors, configuredConnectors) {
  const { wildcardEnabled, enabledConnectorIds, disabledConnectorIds } =
    buildConnectorConfigState(configuredConnectors);
  const expected = [];
  const hasExplicitConnectors = Object.keys(configuredConnectors).length > 0;

  for (const connector of connectors) {
    if (!connector.isAccessible || !connector.isEnabled) {
      continue;
    }

    if (
      shouldExcludeConnectorId(connector.connectorId) ||
      disabledConnectorIds.has(connector.connectorId)
    ) {
      continue;
    }

    if (!hasExplicitConnectors || wildcardEnabled || enabledConnectorIds.has(connector.connectorId)) {
      expected.push(connector.publishedName);
    }
  }

  return expected.sort();
}

function summarizeReturnedConnectors(connectors) {
  return connectors
    .map((connector) => ({
      connectorId: connector.connectorId,
      appId: connector.appId,
      appName: connector.appName,
      publishedName: connector.publishedName,
      isAccessible: connector.isAccessible,
      isEnabled: connector.isEnabled,
    }))
    .sort((a, b) => {
      const left = `${a.appName}:${a.appId}`;
      const right = `${b.appName}:${b.appId}`;
      return left.localeCompare(right);
    });
}

async function loadRawConfig() {
  const explicitPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() || path.join(process.env.HOME || os.homedir(), ".openclaw");
  const configPath = explicitPath || path.join(stateDir, "openclaw.json");

  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

const rawConfig = await loadRawConfig();
const resolvedConfig = resolveChatgptAppsConfig(
  rawConfig?.plugins?.entries?.["openai-apps"]?.config ?? {},
);

const transport = new StdioClientTransport({
  command: "node",
  args: ["--import", "tsx", "./extensions/openai-apps/src/server.ts"],
  cwd: process.cwd(),
  env: process.env,
});

const client = new Client({ name: "chatapps-integ", version: "0.2.0" });
let actualPublishedTools = [];
try {
  await client.connect(transport);
  const response = await client.listTools();
  actualPublishedTools = response.tools.map((tool) => tool.name).sort();
} finally {
  await client.close().catch(() => {});
}

const statePaths = resolveChatgptAppsStatePaths(process.env);
const snapshot = JSON.parse(await readFile(statePaths.snapshotPath, "utf8"));
const expectedPublishedTools = buildExpectedPublishedTools(
  snapshot.connectors ?? [],
  resolvedConfig.connectors ?? {},
);

if (actualPublishedTools.length === 0) {
  throw new Error("Published tool inventory was empty");
}

if (actualPublishedTools.join("\n") !== expectedPublishedTools.join("\n")) {
  console.error("Published tool inventory drift detected");
  console.error("expected:", JSON.stringify(expectedPublishedTools, null, 2));
  console.error("actual:", JSON.stringify(actualPublishedTools, null, 2));
  process.exit(1);
}

const missingRequired = requiredPublishedTools.filter(
  (toolName) => !actualPublishedTools.includes(toolName),
);
if (missingRequired.length > 0) {
  console.error("Missing required published tools");
  console.error(JSON.stringify(missingRequired, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      toolCount: actualPublishedTools.length,
      requiredPublishedTools,
      publishedTools: actualPublishedTools,
      returnedConnectors: summarizeReturnedConnectors(snapshot.connectors ?? []),
    },
    null,
    2,
  ),
);
EOF
  )
}

capture_transcript_summary() {
  local session="$1"
  local expected_tool="$2"
  local output_path="$3"

  python3 "$TRANSCRIPT_READER" \
    "agent:main:${session}" \
    --state-dir "$INTEG_STATE_DIR" \
    --agent main \
    --expect-tool "$expected_tool" \
    >"$output_path"
}

transcript_summary_complete() {
  local output_path="$1"
  python3 - "$output_path" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
if "assistant_tool_calls:" not in text:
    raise SystemExit(1)
if "final_assistant_text_preview:\n<none>" in text:
    raise SystemExit(1)
if "isError=True" in text:
    raise SystemExit(1)
if '"status": "error"' in text:
    raise SystemExit(1)
raise SystemExit(0)
PY
}

transcript_summary_has_error() {
  local output_path="$1"
  python3 - "$output_path" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
if "isError=True" in text or '"status": "error"' in text:
    raise SystemExit(0)
raise SystemExit(1)
PY
}

run_tui_check_once() {
  local session="$1"
  local message="$2"
  local expected_tool="$3"
  local log_path="$4"
  local output_path="$5"
  local tui_pid=""
  local success=0
  local saw_error=0
  local process_exited_checks=0

  (
    cd "$REPO_DIR"
    exec env "${INTEG_ENV[@]}" \
      node scripts/run-node.mjs --dev tui \
      --session "$session" \
      --message "$message"
  ) >"$log_path" 2>&1 &
  tui_pid="$!"
  TUI_PIDS+=("$tui_pid")

  for _ in $(seq 1 120); do
    if capture_transcript_summary "$session" "$expected_tool" "$output_path" 2>/dev/null; then
      if transcript_summary_has_error "$output_path"; then
        saw_error=1
        break
      fi
      if transcript_summary_complete "$output_path"; then
        success=1
        break
      fi
    fi

    if ! kill -0 "$tui_pid" >/dev/null 2>&1; then
      wait "$tui_pid" >/dev/null 2>&1 || true
      process_exited_checks=$((process_exited_checks + 1))
      if (( process_exited_checks >= 3 )); then
        break
      fi
    else
      process_exited_checks=0
    fi

    sleep 2
  done

  terminate_process "$tui_pid"
  local -a remaining_pids=()
  for existing_pid in "${TUI_PIDS[@]:-}"; do
    if [[ "$existing_pid" != "$tui_pid" ]]; then
      remaining_pids+=("$existing_pid")
    fi
  done
  if (( ${#remaining_pids[@]} > 0 )); then
    TUI_PIDS=("${remaining_pids[@]}")
  else
    TUI_PIDS=()
  fi

  if [[ "$success" -ne 1 ]]; then
    if [[ "$saw_error" -eq 1 ]]; then
      return 2
    fi
    return 1
  fi
}

run_tui_check() {
  local session="$1"
  local message="$2"
  local expected_tool="$3"
  local log_path="$4"
  local output_path="$5"
  local attempt_session="$session"
  local attempt_log_path="$log_path"
  local attempt_output_path="$output_path"
  local attempt=1
  local status=1

  while (( attempt <= 2 )); do
    if run_tui_check_once \
      "$attempt_session" \
      "$message" \
      "$expected_tool" \
      "$attempt_log_path" \
      "$attempt_output_path"; then
      return 0
    fi

    status=$?
    if (( attempt == 2 )); then
      if [[ "$status" -eq 2 ]]; then
        [[ -f "$attempt_output_path" ]] && cat "$attempt_output_path" >&2
        fail "connector execution failed for session ${attempt_session}"
      fi
      [[ -f "$attempt_log_path" ]] && tail -n 120 "$attempt_log_path" >&2
      fail "timed out waiting for transcript evidence for session ${attempt_session}"
    fi

    attempt=$((attempt + 1))
    attempt_session="${session}-retry$((attempt - 1))"
    attempt_log_path="${log_path%.log}-retry$((attempt - 1)).log"
    attempt_output_path="${output_path%.txt}-retry$((attempt - 1)).txt"
  done
}

build_google_calendar_prompt() {
  python3 - <<'PY'
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

tz = ZoneInfo("America/Los_Angeles")
today = datetime.now(tz).date()
week_start = today - timedelta(days=today.weekday())
week_end = week_start + timedelta(days=6)

print(
    "Use the Google Calendar app tools now. "
    f"Show me my schedule this week, interpreted in America/Los_Angeles as Monday {week_start.isoformat()} through Sunday {week_end.isoformat()} inclusive. "
    "Summarize the events in concise bullets with date, start time, end time, title, calendar name if available, "
    "location if available, and whether the event is all-day. "
    "Do not use browser tools. Do not ask follow-up questions."
)
PY
}

generate_showboat_demo() {
  local title
  if [[ "$MODE" == "simple" ]]; then
    title="ChatGPT Apps Connector Demo (Simple)"
  else
    title="ChatGPT Apps Connector Demo (Full)"
  fi

  rm -f "$DEMO_FILE"
  (
    cd "$REPO_DIR"
    uvx showboat init "$DEMO_FILE" "$title"
    uvx showboat note "$DEMO_FILE" \
      "Generated by \`extensions/openai-apps/integ/test-chatapps-integ.sh ${MODE}\`. This proof doc summarizes the published app snapshot plus transcript evidence from the latest live run under \`${ROOT_DIR}\`."
    uvx showboat exec "$DEMO_FILE" bash "cat ${LIST_TOOLS_SUMMARY_JSON}"
    uvx showboat exec "$DEMO_FILE" bash "cat ${GMAIL_SUMMARY}"
    if [[ "$MODE" == "full" ]]; then
      uvx showboat exec "$DEMO_FILE" bash "cat ${LINEAR_SUMMARY}"
      uvx showboat exec "$DEMO_FILE" bash "cat ${GCAL_SUMMARY}"
    fi
    uvx showboat verify "$DEMO_FILE"
  )
}

main() {
  local required_published_tools_json='["chatgpt_app_gmail"]'
  if [[ "$MODE" == "full" ]]; then
    required_published_tools_json='["chatgpt_app_gmail","chatgpt_app_linear","chatgpt_app_google_calendar"]'
  fi

  prepare_output_dir
  require_prereqs
  prepare_integration_profile
  start_fresh_gateway
  capture_list_tools_summary "$required_published_tools_json"

  run_tui_check \
    "$GMAIL_SESSION" \
    "Use the Gmail app tools now. Summarize my most recent inbox email in 3 short bullets. Do not ask follow-up questions." \
    "chatgpt_app_gmail" \
    "$GMAIL_LOG" \
    "$GMAIL_SUMMARY"

  if [[ "$MODE" == "full" ]]; then
    run_tui_check \
      "$LINEAR_SESSION" \
      "Use the Linear app tools now. Find the Linear tasks assigned to me and summarize them in concise bullets. Do not use browser tools. Do not ask follow-up questions." \
      "chatgpt_app_linear" \
      "$LINEAR_LOG" \
      "$LINEAR_SUMMARY"

    run_tui_check \
      "$GCAL_SESSION" \
      "$(build_google_calendar_prompt)" \
      "chatgpt_app_google_calendar" \
      "$GCAL_LOG" \
      "$GCAL_SUMMARY"
  fi

  generate_showboat_demo

  echo "demo_file=${DEMO_FILE}"
  echo "artifacts_dir=${ROOT_DIR}"
}

main "$@"
