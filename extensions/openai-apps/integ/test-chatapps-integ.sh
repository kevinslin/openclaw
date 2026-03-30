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
DEV_STATE_DIR="${HOME}/.openclaw-dev"
DEV_CONFIG_PATH="${DEV_STATE_DIR}/openclaw.json"
DEV_AGENT_DIR="${DEV_STATE_DIR}/agents/dev/agent"

GATEWAY_PID=""
STARTED_GATEWAY=0
GATEWAY_PORT="19001"
RUN_NODE_PATH="${REPO_DIR}/scripts/run-node.mjs"
TUI_PIDS=()
DEV_ENV=(
  OPENCLAW_PROFILE=dev
  OPENCLAW_STATE_DIR="$DEV_STATE_DIR"
  OPENCLAW_CONFIG_PATH="$DEV_CONFIG_PATH"
  OPENCLAW_AGENT_DIR="$DEV_AGENT_DIR"
)

cleanup() {
  local status=$?
  for pid in "${TUI_PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  done
  if [[ "$STARTED_GATEWAY" -eq 1 && -n "$GATEWAY_PID" ]]; then
    kill "$GATEWAY_PID" >/dev/null 2>&1 || true
    wait "$GATEWAY_PID" >/dev/null 2>&1 || true
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

prepare_dev_profile() {
  mkdir -p "$DEV_STATE_DIR" "$DEV_AGENT_DIR"

  if [[ -f "${REPO_DIR}/scripts/prepare-dev-profile.mjs" ]]; then
    (
      cd "$REPO_DIR"
      env "${DEV_ENV[@]}" node scripts/prepare-dev-profile.mjs
    )
  elif [[ ! -f "$DEV_CONFIG_PATH" ]]; then
    fail "dev profile config missing at ${DEV_CONFIG_PATH}"
  fi
}

start_fresh_gateway() {
  terminate_matching_dev_processes

  if gateway_listening; then
    return 0
  fi

  (
    cd "$REPO_DIR"
    env OPENCLAW_SKIP_CHANNELS=1 "${DEV_ENV[@]}" \
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
    env "${DEV_ENV[@]}" REQUIRED_PUBLISHED_TOOLS_JSON="$required_tools_json" \
      node --input-type=module --import tsx <<'EOF' >"$LIST_TOOLS_SUMMARY_JSON"
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveChatgptAppsConfig } from "./extensions/openai-apps/src/config.js";
import { resolveChatgptAppsStatePaths } from "./extensions/openai-apps/src/state-paths.js";

const requiredPublishedTools = JSON.parse(process.env.REQUIRED_PUBLISHED_TOOLS_JSON ?? "[]");

const EXCLUDED_CONNECTOR_IDS = new Set([
  "collab",
  "connector_openai_general_agent",
  "general_agent",
]);

function normalizeConnectorKey(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function looksLikeOpaqueAppId(value) {
  return value.startsWith("connector_") || value.startsWith("asdk_app_");
}

function deriveConnectorKeysFromApp(app) {
  const candidates = new Set();

  if (!looksLikeOpaqueAppId(app.id)) {
    const normalizedId = normalizeConnectorKey(app.id);
    if (normalizedId) {
      candidates.add(normalizedId);
    }
  }

  for (const value of [app.name, ...(app.pluginDisplayNames ?? [])]) {
    const normalized = normalizeConnectorKey(String(value ?? ""));
    if (normalized) {
      candidates.add(normalized);
    }
  }

  return [...candidates];
}

function shouldExcludeConnectorId(connectorId) {
  if (!connectorId) {
    return false;
  }
  return EXCLUDED_CONNECTOR_IDS.has(normalizeConnectorKey(connectorId));
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

function buildExpectedPublishedTools(inventory, configuredConnectors) {
  const { wildcardEnabled, enabledConnectorIds, disabledConnectorIds } =
    buildConnectorConfigState(configuredConnectors);
  const expected = [];
  const seenConnectorIds = new Set();
  const hasExplicitConnectors = Object.keys(configuredConnectors).length > 0;

  for (const app of inventory) {
    if (!app.isAccessible || !app.isEnabled) {
      continue;
    }

    for (const connectorId of deriveConnectorKeysFromApp(app)) {
      if (
        shouldExcludeConnectorId(connectorId) ||
        disabledConnectorIds.has(connectorId) ||
        seenConnectorIds.has(connectorId)
      ) {
        continue;
      }

      if (!hasExplicitConnectors || wildcardEnabled || enabledConnectorIds.has(connectorId)) {
        seenConnectorIds.add(connectorId);
        expected.push(`chatgpt_app_${connectorId}`);
      }
    }
  }

  return expected.sort();
}

function summarizeReturnedApps(inventory) {
  return inventory
    .filter((app) => app.isAccessible && app.isEnabled)
    .map((app) => ({
      id: app.id,
      name: app.name,
      connectorIds: deriveConnectorKeysFromApp(app)
        .filter((connectorId) => !shouldExcludeConnectorId(connectorId))
        .sort(),
    }))
    .sort((a, b) => {
      const left = `${a.name}:${a.id}`;
      const right = `${b.name}:${b.id}`;
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
  snapshot.inventory ?? [],
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
      returnedApps: summarizeReturnedApps(snapshot.inventory ?? []),
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
    "agent:dev:${session}" \
    --profile dev \
    --agent dev \
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
    exec env "${DEV_ENV[@]}" \
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

  kill "$tui_pid" >/dev/null 2>&1 || true
  wait "$tui_pid" >/dev/null 2>&1 || true
  TUI_PIDS=("${TUI_PIDS[@]/$tui_pid}")

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
  prepare_dev_profile
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
