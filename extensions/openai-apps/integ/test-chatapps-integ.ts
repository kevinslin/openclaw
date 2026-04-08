#!/usr/bin/env -S node --import tsx

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveChatgptAppsConfig } from "../src/config.js";
import { shouldExcludeConnectorId } from "../src/connector-record.js";
import { resolveChatgptAppsStatePaths } from "../src/state-paths.js";

type Mode = "simple" | "full" | "write";

type ConnectorConfigEntry = {
  enabled?: boolean;
};

type ConnectorSnapshot = {
  connectorId: string;
  appId: string;
  appName: string;
  publishedName: string;
  isAccessible: boolean;
  isEnabled: boolean;
};

type RunContext = {
  gatewayChild: ReturnType<typeof spawn> | null;
  startedGateway: boolean;
  tuiChildren: Set<ReturnType<typeof spawn>>;
  cleanupStarted: boolean;
};

type RunTuiCheckStatus = "success" | "error" | "timeout";

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const INTEG_DIR = path.dirname(SCRIPT_PATH);
const EXTENSION_DIR = path.resolve(INTEG_DIR, "..");
const REPO_DIR = path.resolve(EXTENSION_DIR, "..", "..");
const ROOT_DIR = "/tmp/claw-chat-apps";
const TRANSCRIPT_READER =
  "/Users/kevinlin/code/kl-oai-skills/claw-conn-debug/scripts/read_tui_session.py";
const INTEG_PROFILE = "chatapps-integ";
const INTEG_STATE_DIR = path.join(os.homedir(), `.openclaw-${INTEG_PROFILE}`);
const INTEG_CONFIG_PATH = path.join(INTEG_STATE_DIR, "openclaw.json");
const INTEG_WORKSPACE_DIR = path.join(INTEG_STATE_DIR, "workspace");
const INTEG_AGENT_ID = INTEG_PROFILE;
const INTEG_AGENT_DIR = path.join(INTEG_STATE_DIR, "agents", INTEG_AGENT_ID, "agent");
const INTEG_MAIN_AGENT_DIR = path.join(INTEG_STATE_DIR, "agents", "main", "agent");
const INTEG_AGENT_AUTH_PATH = path.join(INTEG_AGENT_DIR, "auth-profiles.json");
const INTEG_MAIN_AUTH_PATH = path.join(INTEG_MAIN_AGENT_DIR, "auth-profiles.json");
const RUN_NODE_PATH = path.join(REPO_DIR, "scripts", "run-node.mjs");

const GATEWAY_PORT = Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? "19011", 10);

const LIST_TOOLS_SUMMARY_JSON = path.join(ROOT_DIR, "list-tools-summary.json");
const GMAIL_LOG = path.join(ROOT_DIR, "gmail-tui.log");
const GMAIL_SUMMARY = path.join(ROOT_DIR, "gmail-summary.txt");
const LINEAR_LOG = path.join(ROOT_DIR, "linear-tui.log");
const LINEAR_SUMMARY = path.join(ROOT_DIR, "linear-summary.txt");
const GCAL_LOG = path.join(ROOT_DIR, "gcal-tui.log");
const GCAL_SUMMARY = path.join(ROOT_DIR, "gcal-summary.txt");
const WRITE_ALWAYS_SUMMARY = path.join(ROOT_DIR, "write-always-summary.json");
const WRITE_NEVER_SUMMARY = path.join(ROOT_DIR, "write-never-summary.json");
const GATEWAY_LOG = path.join(ROOT_DIR, "gateway.log");

function usage(): string {
  return `Usage: extensions/openai-apps/integ/test-chatapps-integ.ts [simple|full|write]

Runs the live ChatGPT apps connector integration suite against the dev gateway,
writes artifacts to /tmp/claw-chat-apps/, generates a Showboat proof doc, and
returns 0 on success or 1 on failure.

Modes:
  simple  Verify list tools and Gmail
  full    Verify list tools, Gmail, Linear, and Google Calendar
  write   Verify Google Calendar write behavior for allowDestructiveActions`;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseMode(argv: string[]): Mode {
  const arg = argv[2];
  if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(0);
    throw new Error("unreachable");
  }
  if (arg === undefined) {
    return "full";
  }
  if (arg === "simple" || arg === "full" || arg === "write") {
    return arg;
  }
  console.error(usage());
  process.exit(1);
  throw new Error("unreachable");
}

function buildSessionSuffix(now = new Date()): string {
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ];
  return parts.join("");
}

function buildIntegrationEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_PROFILE: INTEG_PROFILE,
    OPENCLAW_STATE_DIR: INTEG_STATE_DIR,
    OPENCLAW_CONFIG_PATH: INTEG_CONFIG_PATH,
    OPENCLAW_WORKSPACE_DIR: INTEG_WORKSPACE_DIR,
    OPENCLAW_AGENT_DIR: INTEG_AGENT_DIR,
    OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
  };
}

function toStrictEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOpenaiAppsRawConfig(rawConfig: unknown): unknown {
  if (!isRecord(rawConfig)) {
    return {};
  }
  const plugins = rawConfig.plugins;
  if (!isRecord(plugins)) {
    return {};
  }
  const entries = plugins.entries;
  if (!isRecord(entries)) {
    return {};
  }
  const openaiApps = entries["openai-apps"];
  if (!isRecord(openaiApps)) {
    return {};
  }
  return openaiApps.config ?? {};
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeConnectorKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function buildConnectorConfigState(configuredConnectors: Record<string, ConnectorConfigEntry>): {
  wildcardEnabled: boolean;
  enabledConnectorIds: Set<string>;
  disabledConnectorIds: Set<string>;
} {
  let wildcardEnabled = false;
  const enabledConnectorIds = new Set<string>();
  const disabledConnectorIds = new Set<string>();

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

function buildExpectedPublishedTools(
  connectors: ConnectorSnapshot[],
  configuredConnectors: Record<string, ConnectorConfigEntry>,
): string[] {
  const { wildcardEnabled, enabledConnectorIds, disabledConnectorIds } =
    buildConnectorConfigState(configuredConnectors);
  const expected: string[] = [];
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
    if (
      !hasExplicitConnectors ||
      wildcardEnabled ||
      enabledConnectorIds.has(connector.connectorId)
    ) {
      expected.push(connector.publishedName);
    }
  }

  return expected.sort();
}

function summarizeReturnedConnectors(connectors: ConnectorSnapshot[]): ConnectorSnapshot[] {
  return connectors
    .map((connector) => ({
      connectorId: connector.connectorId,
      appId: connector.appId,
      appName: connector.appName,
      publishedName: connector.publishedName,
      isAccessible: connector.isAccessible,
      isEnabled: connector.isEnabled,
    }))
    .sort((left, right) => {
      const leftKey = `${left.appName}:${left.appId}`;
      const rightKey = `${right.appName}:${right.appId}`;
      return leftKey.localeCompare(rightKey);
    });
}

async function loadRawConfig(env: NodeJS.ProcessEnv): Promise<unknown> {
  const explicitPath = env.OPENCLAW_CONFIG_PATH?.trim();
  const stateDir =
    env.OPENCLAW_STATE_DIR?.trim() || path.join(env.HOME || os.homedir(), ".openclaw");
  const configPath = explicitPath || path.join(stateDir, "openclaw.json");
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function describeExecError(error: unknown): string {
  if (error instanceof Error) {
    const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
    return [error.message, stdout, stderr].filter(Boolean).join("\n");
  }
  return String(error);
}

async function execCommand(params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const result = await execFileAsync(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}

async function ensureDirectory(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminatePid(pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  if (!pidIsRunning(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!pidIsRunning(pid)) {
      return;
    }
    await sleep(1_000);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore already-exited processes.
  }
}

async function cleanup(context: RunContext): Promise<void> {
  if (context.cleanupStarted) {
    return;
  }
  context.cleanupStarted = true;

  for (const child of [...context.tuiChildren]) {
    const pid = child.pid;
    if (typeof pid === "number") {
      await terminatePid(pid);
    }
    context.tuiChildren.delete(child);
  }

  if (context.startedGateway && context.gatewayChild?.pid) {
    await terminatePid(context.gatewayChild.pid);
  }
}

function installSignalHandlers(context: RunContext): () => void {
  const handleSignal = (signal: NodeJS.Signals) => {
    void (async () => {
      await cleanup(context);
      process.exit(signal === "SIGINT" ? 130 : 143);
    })();
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  return () => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  };
}

async function gatewayListening(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForGateway(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await gatewayListening(GATEWAY_PORT)) {
      const logText = await safeReadFile(GATEWAY_LOG);
      if (
        logText.includes(`listening on ws://127.0.0.1:${GATEWAY_PORT}`) ||
        logText.includes("already running under launchd")
      ) {
        return;
      }
    }
    await sleep(1_000);
  }
  fail("dev gateway did not become ready");
}

async function safeReadFile(targetPath: string): Promise<string> {
  try {
    return await readFile(targetPath, "utf8");
  } catch {
    return "";
  }
}

async function terminateMatchingDevProcesses(): Promise<void> {
  const psOutput = await execCommand({
    command: "ps",
    args: ["-axo", "pid=,command="],
  });

  const pids = psOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1], 10),
        command: match[2],
      };
    })
    .filter((entry): entry is { pid: number; command: string } => entry !== null)
    .filter(
      (entry) =>
        entry.command.includes(RUN_NODE_PATH) &&
        (entry.command.includes("--dev gateway") || entry.command.includes("--dev tui")),
    )
    .map((entry) => entry.pid);

  if (pids.length === 0) {
    return;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore already-exited processes.
    }
  }
  await sleep(1_000);

  for (const pid of pids) {
    if (!pidIsRunning(pid)) {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore already-exited processes.
    }
  }
}

async function prepareOutputDir(): Promise<void> {
  await rm(ROOT_DIR, { recursive: true, force: true });
  await ensureDirectory(ROOT_DIR);
}

async function requirePrereqs(): Promise<void> {
  if (!(await isFile(TRANSCRIPT_READER))) {
    fail(`missing transcript reader at ${TRANSCRIPT_READER}`);
  }
  try {
    await execCommand({
      command: "uvx",
      args: ["showboat", "--help"],
      cwd: REPO_DIR,
      env: buildIntegrationEnv(),
    });
  } catch (error) {
    fail(`uvx showboat is not available\n${describeExecError(error)}`);
  }
}

type AuthProfilesStore = {
  profiles?: Record<string, unknown>;
};

function hasReusableOpenaiCodexAuth(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }
  const profiles = raw.profiles;
  if (!isRecord(profiles)) {
    return false;
  }

  for (const credential of Object.values(profiles)) {
    if (!isRecord(credential)) {
      continue;
    }
    if (credential.type !== "oauth") {
      continue;
    }
    if (credential.provider !== "openai-codex") {
      continue;
    }
    const access = credential.access;
    const accountId = credential.accountId;
    if (
      typeof access === "string" &&
      access.trim() &&
      typeof accountId === "string" &&
      accountId.trim()
    ) {
      return true;
    }
  }

  return false;
}

async function authStoreHasOpenaiCodexLogin(authPath: string): Promise<boolean> {
  try {
    if (!(await isFile(authPath))) {
      return false;
    }
    const raw = JSON.parse(await readFile(authPath, "utf8")) as AuthProfilesStore;
    return hasReusableOpenaiCodexAuth(raw);
  } catch {
    return false;
  }
}

async function listCandidateStateDirs(): Promise<string[]> {
  const homeDir = os.homedir();
  const targetStateDir = path.resolve(INTEG_STATE_DIR);
  const stateDirs: string[] = [];

  const defaultStateDir = path.join(homeDir, ".openclaw");
  if ((await isDirectory(defaultStateDir)) && path.resolve(defaultStateDir) !== targetStateDir) {
    stateDirs.push(defaultStateDir);
  }

  const entries = await readdir(homeDir, { withFileTypes: true });
  const prefixedDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".openclaw-"))
    .map((entry) => path.join(homeDir, entry.name))
    .filter((candidate) => path.resolve(candidate) !== targetStateDir)
    .sort((left, right) => left.localeCompare(right));

  stateDirs.push(...prefixedDirs);
  return stateDirs;
}

async function findProfileConfigSource(): Promise<string | null> {
  for (const stateDir of await listCandidateStateDirs()) {
    const configPath = path.join(stateDir, "openclaw.json");
    if (await isFile(configPath)) {
      return configPath;
    }
  }
  return null;
}

async function findOpenaiCodexAuthSource(): Promise<string | null> {
  for (const stateDir of await listCandidateStateDirs()) {
    const candidates: string[] = [];
    const mainAuth = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    if (await isFile(mainAuth)) {
      candidates.push(mainAuth);
    }

    const agentsDir = path.join(stateDir, "agents");
    if (await isDirectory(agentsDir)) {
      const agentEntries = await readdir(agentsDir, { withFileTypes: true });
      for (const entry of agentEntries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const authPath = path.join(agentsDir, entry.name, "agent", "auth-profiles.json");
        if (!candidates.includes(authPath) && (await isFile(authPath))) {
          candidates.push(authPath);
        }
      }
    }

    for (const candidate of candidates.sort((left, right) => left.localeCompare(right))) {
      if (await authStoreHasOpenaiCodexLogin(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function ensureIntegrationProfileConfig(): Promise<void> {
  await Promise.all([
    ensureDirectory(INTEG_STATE_DIR),
    ensureDirectory(INTEG_WORKSPACE_DIR),
    ensureDirectory(INTEG_AGENT_DIR),
    ensureDirectory(path.join(INTEG_STATE_DIR, "agents", INTEG_AGENT_ID, "sessions")),
    ensureDirectory(INTEG_MAIN_AGENT_DIR),
    ensureDirectory(path.join(INTEG_STATE_DIR, "agents", "main", "sessions")),
  ]);

  if (!(await pathExists(INTEG_CONFIG_PATH))) {
    const sourceConfig = await findProfileConfigSource();
    if (sourceConfig) {
      await copyFile(sourceConfig, INTEG_CONFIG_PATH);
    } else {
      await writeFile(INTEG_CONFIG_PATH, "{}\n", "utf8");
    }
  }

  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(INTEG_CONFIG_PATH, "utf8")) as unknown;
  } catch {
    raw = {};
  }

  const config = isRecord(raw) ? raw : {};
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  config.plugins = plugins;
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  plugins.entries = entries;

  const openaiEntry = isRecord(entries.openai) ? entries.openai : {};
  entries.openai = openaiEntry;
  openaiEntry.enabled = true;

  const appsEntry = isRecord(entries["openai-apps"]) ? entries["openai-apps"] : {};
  entries["openai-apps"] = appsEntry;
  appsEntry.enabled = true;

  const appsConfig = isRecord(appsEntry.config) ? appsEntry.config : {};
  appsEntry.config = appsConfig;
  appsConfig.enabled = true;

  const connectors = isRecord(appsConfig.connectors) ? appsConfig.connectors : {};
  appsConfig.connectors = connectors;

  const wildcard = isRecord(connectors["*"]) ? connectors["*"] : {};
  connectors["*"] = wildcard;
  wildcard.enabled = true;

  const slots = isRecord(plugins.slots) ? plugins.slots : {};
  plugins.slots = slots;
  slots.memory = "none";

  const agents = isRecord(config.agents) ? config.agents : {};
  config.agents = agents;
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  agents.defaults = defaults;
  defaults.workspace = path.join(path.dirname(INTEG_CONFIG_PATH), "workspace");
  defaults.skipBootstrap = true;

  const memorySearch = isRecord(defaults.memorySearch) ? defaults.memorySearch : {};
  defaults.memorySearch = memorySearch;
  memorySearch.enabled = false;

  const hooks = isRecord(config.hooks) ? config.hooks : {};
  config.hooks = hooks;
  const internalHooks = isRecord(hooks.internal) ? hooks.internal : {};
  hooks.internal = internalHooks;
  const hookEntries = isRecord(internalHooks.entries) ? internalHooks.entries : {};
  internalHooks.entries = hookEntries;
  const sessionMemory = isRecord(hookEntries["session-memory"])
    ? hookEntries["session-memory"]
    : {};
  hookEntries["session-memory"] = sessionMemory;
  sessionMemory.enabled = false;

  await writeFile(INTEG_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function ensureIntegrationProfileOpenaiAuth(): Promise<void> {
  await Promise.all([ensureDirectory(INTEG_AGENT_DIR), ensureDirectory(INTEG_MAIN_AGENT_DIR)]);

  let existingAuth: string | null = null;
  if (await authStoreHasOpenaiCodexLogin(INTEG_AGENT_AUTH_PATH)) {
    existingAuth = INTEG_AGENT_AUTH_PATH;
  } else if (await authStoreHasOpenaiCodexLogin(INTEG_MAIN_AUTH_PATH)) {
    existingAuth = INTEG_MAIN_AUTH_PATH;
  }

  if (!existingAuth) {
    existingAuth = await findOpenaiCodexAuthSource();
  }

  if (!existingAuth) {
    fail(
      "No OpenClaw profile has reusable openai-codex OAuth for ChatGPT apps. Log in first with 'openclaw models auth login --provider openai-codex' in any OpenClaw profile, then rerun this integration test.",
    );
  }

  if (existingAuth !== INTEG_MAIN_AUTH_PATH) {
    await copyFile(existingAuth, INTEG_MAIN_AUTH_PATH);
  }
  if (existingAuth !== INTEG_AGENT_AUTH_PATH) {
    await copyFile(existingAuth, INTEG_AGENT_AUTH_PATH);
  }

  if (!(await authStoreHasOpenaiCodexLogin(INTEG_AGENT_AUTH_PATH))) {
    fail("integration profile auth copy did not produce a reusable openai-codex login");
  }
}

async function prepareIntegrationProfile(integEnv: NodeJS.ProcessEnv): Promise<void> {
  await rm(INTEG_WORKSPACE_DIR, { recursive: true, force: true });
  await ensureDirectory(INTEG_WORKSPACE_DIR);
  await ensureIntegrationProfileConfig();
  await ensureIntegrationProfileOpenaiAuth();

  const prepareDevProfilePath = path.join(REPO_DIR, "scripts", "prepare-dev-profile.mjs");
  if (await isFile(prepareDevProfilePath)) {
    await execCommand({
      command: "node",
      args: ["scripts/prepare-dev-profile.mjs"],
      cwd: REPO_DIR,
      env: integEnv,
    });
  } else if (!(await isFile(INTEG_CONFIG_PATH))) {
    fail(`integration profile config missing at ${INTEG_CONFIG_PATH}`);
  }
}

function spawnLoggedProcess(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}): ReturnType<typeof spawn> {
  const fd = openSync(params.logPath, "w");
  try {
    return spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
}

async function startFreshGateway(context: RunContext, integEnv: NodeJS.ProcessEnv): Promise<void> {
  await terminateMatchingDevProcesses();

  if (await gatewayListening(GATEWAY_PORT)) {
    fail(
      `gateway port ${GATEWAY_PORT} is already in use; stop the existing listener or rerun with OPENCLAW_GATEWAY_PORT set to a free port`,
    );
  }

  context.gatewayChild = spawnLoggedProcess({
    command: "node",
    args: ["scripts/run-node.mjs", "--dev", "gateway"],
    cwd: REPO_DIR,
    env: {
      ...integEnv,
      OPENCLAW_SKIP_CHANNELS: "1",
    },
    logPath: GATEWAY_LOG,
  });
  context.startedGateway = true;

  await waitForGateway().catch(async (error) => {
    const gatewayLog = await safeReadFile(GATEWAY_LOG);
    if (gatewayLog.trim()) {
      console.error(gatewayLog);
    }
    throw error;
  });
}

async function captureListToolsSummary(
  requiredPublishedTools: string[],
  integEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const rawConfig = await loadRawConfig(integEnv);
  const resolvedConfig = resolveChatgptAppsConfig(getOpenaiAppsRawConfig(rawConfig));

  const transport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", "./extensions/openai-apps/src/server.ts"],
    cwd: REPO_DIR,
    env: toStrictEnv(integEnv),
  });

  const client = new Client({ name: "chatapps-integ", version: "0.2.0" });
  let actualPublishedTools: string[] = [];

  try {
    await client.connect(transport);
    const response = await client.listTools();
    actualPublishedTools = response.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close().catch(() => {});
  }

  const statePaths = resolveChatgptAppsStatePaths(integEnv);
  const snapshotRaw = JSON.parse(await readFile(statePaths.snapshotPath, "utf8")) as {
    connectors?: ConnectorSnapshot[];
  };
  const snapshotConnectors = Array.isArray(snapshotRaw.connectors) ? snapshotRaw.connectors : [];
  const configuredConnectors = (resolvedConfig.connectors ?? {}) as Record<
    string,
    ConnectorConfigEntry
  >;
  const expectedPublishedTools = buildExpectedPublishedTools(
    snapshotConnectors,
    configuredConnectors,
  );

  if (actualPublishedTools.length === 0) {
    fail("Published tool inventory was empty");
  }

  if (actualPublishedTools.join("\n") !== expectedPublishedTools.join("\n")) {
    console.error("Published tool inventory drift detected");
    console.error("expected:", JSON.stringify(expectedPublishedTools, null, 2));
    console.error("actual:", JSON.stringify(actualPublishedTools, null, 2));
    fail("published tool inventory did not match snapshot expectations");
  }

  const missingRequired = requiredPublishedTools.filter(
    (toolName) => !actualPublishedTools.includes(toolName),
  );
  if (missingRequired.length > 0) {
    console.error("Missing required published tools");
    console.error(JSON.stringify(missingRequired, null, 2));
    fail("required published tools were missing");
  }

  const summary = {
    toolCount: actualPublishedTools.length,
    requiredPublishedTools,
    publishedTools: actualPublishedTools,
    returnedConnectors: summarizeReturnedConnectors(snapshotConnectors),
  };
  await writeFile(LIST_TOOLS_SUMMARY_JSON, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

async function captureTranscriptSummary(
  session: string,
  expectedTool: string,
  outputPath: string,
): Promise<void> {
  const stdout = await execCommand({
    command: "python3",
    args: [
      TRANSCRIPT_READER,
      `agent:main:${session}`,
      "--state-dir",
      INTEG_STATE_DIR,
      "--agent",
      "main",
      "--expect-tool",
      expectedTool,
    ],
  });
  await writeFile(outputPath, stdout, "utf8");
}

async function transcriptSummaryComplete(outputPath: string): Promise<boolean> {
  const text = await readFile(outputPath, "utf8");
  if (!text.includes("assistant_tool_calls:")) {
    return false;
  }
  if (text.includes("final_assistant_text_preview:\n<none>")) {
    return false;
  }
  if (text.includes("isError=True")) {
    return false;
  }
  if (text.includes('"status": "error"')) {
    return false;
  }
  return true;
}

async function transcriptSummaryHasError(outputPath: string): Promise<boolean> {
  const text = await readFile(outputPath, "utf8");
  return text.includes("isError=True") || text.includes('"status": "error"');
}

async function runWriteActionCase(
  caseName: "write-always" | "write-never",
  outputPath: string,
  integEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const stdout = await execCommand({
    command: "node",
    args: [
      "--import",
      "tsx",
      "./extensions/openai-apps/integ/verify-destructive-action-case.ts",
      caseName,
    ],
    cwd: REPO_DIR,
    env: {
      ...integEnv,
      OPENCLAW_SHOWBOAT_SOURCE_ROOT: INTEG_STATE_DIR,
      OPENCLAW_SHOWBOAT_SOURCE_CONFIG_PATH: INTEG_CONFIG_PATH,
      OPENCLAW_SHOWBOAT_SOURCE_AGENT_DIR: INTEG_MAIN_AGENT_DIR,
      OPENCLAW_SHOWBOAT_SOURCE_SNAPSHOT_PATH: path.join(
        INTEG_STATE_DIR,
        "plugin-runtimes",
        "openai-apps",
        "connectors.snapshot.json",
      ),
    },
  });
  await writeFile(outputPath, stdout, "utf8");
}

async function runTuiCheckOnce(params: {
  session: string;
  message: string;
  expectedTool: string;
  logPath: string;
  outputPath: string;
  context: RunContext;
  integEnv: NodeJS.ProcessEnv;
}): Promise<RunTuiCheckStatus> {
  const child = spawnLoggedProcess({
    command: "node",
    args: [
      "scripts/run-node.mjs",
      "--dev",
      "tui",
      "--session",
      params.session,
      "--message",
      params.message,
    ],
    cwd: REPO_DIR,
    env: params.integEnv,
    logPath: params.logPath,
  });
  params.context.tuiChildren.add(child);

  let processExitedChecks = 0;

  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        await captureTranscriptSummary(params.session, params.expectedTool, params.outputPath);
        if (await transcriptSummaryHasError(params.outputPath)) {
          return "error";
        }
        if (await transcriptSummaryComplete(params.outputPath)) {
          return "success";
        }
      } catch {
        // Ignore until the transcript is available.
      }

      if (child.exitCode !== null || child.signalCode !== null) {
        processExitedChecks += 1;
        if (processExitedChecks >= 3) {
          break;
        }
      } else {
        processExitedChecks = 0;
      }

      await sleep(2_000);
    }

    return "timeout";
  } finally {
    if (child.pid) {
      await terminatePid(child.pid);
    }
    params.context.tuiChildren.delete(child);
  }
}

async function runTuiCheck(params: {
  session: string;
  message: string;
  expectedTool: string;
  logPath: string;
  outputPath: string;
  context: RunContext;
  integEnv: NodeJS.ProcessEnv;
}): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptSuffix = attempt === 1 ? "" : `-retry${attempt - 1}`;
    const attemptSession = `${params.session}${attemptSuffix}`;
    const attemptLogPath =
      attempt === 1 ? params.logPath : params.logPath.replace(/\.log$/, `${attemptSuffix}.log`);
    const attemptOutputPath =
      attempt === 1
        ? params.outputPath
        : params.outputPath.replace(/\.txt$/, `${attemptSuffix}.txt`);
    const status = await runTuiCheckOnce({
      ...params,
      session: attemptSession,
      logPath: attemptLogPath,
      outputPath: attemptOutputPath,
    });

    if (status === "success") {
      return;
    }
    if (attempt === 2) {
      if (status === "error") {
        const output = await safeReadFile(attemptOutputPath);
        if (output.trim()) {
          console.error(output);
        }
        fail(`connector execution failed for session ${attemptSession}`);
      }
      const logTail = await safeReadFile(attemptLogPath);
      if (logTail.trim()) {
        console.error(logTail.split("\n").slice(-120).join("\n"));
      }
      fail(`timed out waiting for transcript evidence for session ${attemptSession}`);
    }
  }
}

function buildGoogleCalendarPrompt(): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = Number.parseInt(parts.find((part) => part.type === "year")?.value ?? "", 10);
  const month = Number.parseInt(parts.find((part) => part.type === "month")?.value ?? "", 10);
  const day = Number.parseInt(parts.find((part) => part.type === "day")?.value ?? "", 10);

  const localDate = new Date(Date.UTC(year, month - 1, day));
  const mondayOffset = (localDate.getUTCDay() + 6) % 7;
  const weekStart = new Date(localDate);
  weekStart.setUTCDate(weekStart.getUTCDate() - mondayOffset);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);

  const weekStartIso = weekStart.toISOString().slice(0, 10);
  const weekEndIso = weekEnd.toISOString().slice(0, 10);

  return [
    "Use the Google Calendar app tools now.",
    `Show me my schedule this week, interpreted in America/Los_Angeles as Monday ${weekStartIso} through Sunday ${weekEndIso} inclusive.`,
    "Summarize the events in concise bullets with date, start time, end time, title, calendar name if available,",
    "location if available, and whether the event is all-day.",
    "Do not use browser tools. Do not ask follow-up questions.",
  ].join(" ");
}

async function generateShowboatDemo(mode: Mode): Promise<string> {
  const demoFile = path.join(ROOT_DIR, `demo-${mode}.md`);
  let title = "ChatGPT Apps Connector Demo";
  if (mode === "simple") {
    title = "ChatGPT Apps Connector Demo (Simple)";
  } else if (mode === "full") {
    title = "ChatGPT Apps Connector Demo (Full)";
  } else if (mode === "write") {
    title = "ChatGPT Apps Connector Demo (Write)";
  }

  await rm(demoFile, { force: true });

  const runShowboat = async (...args: string[]) => {
    await execCommand({
      command: "uvx",
      args: ["showboat", ...args],
      cwd: REPO_DIR,
      env: buildIntegrationEnv(),
    });
  };

  await runShowboat("init", demoFile, title);
  await runShowboat(
    "note",
    demoFile,
    `Generated by \`extensions/openai-apps/integ/test-chatapps-integ.ts ${mode}\`. This proof doc summarizes the published app snapshot plus transcript evidence from the latest live run under \`${ROOT_DIR}\`.`,
  );
  await runShowboat("exec", demoFile, "bash", `cat ${LIST_TOOLS_SUMMARY_JSON}`);
  if (mode === "write") {
    await runShowboat("exec", demoFile, "bash", `cat ${WRITE_ALWAYS_SUMMARY}`);
    await runShowboat("exec", demoFile, "bash", `cat ${WRITE_NEVER_SUMMARY}`);
  } else {
    await runShowboat("exec", demoFile, "bash", `cat ${GMAIL_SUMMARY}`);
  }
  if (mode === "full") {
    await runShowboat("exec", demoFile, "bash", `cat ${LINEAR_SUMMARY}`);
    await runShowboat("exec", demoFile, "bash", `cat ${GCAL_SUMMARY}`);
  }
  await runShowboat("verify", demoFile);

  return demoFile;
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv);
  const sessionSuffix = buildSessionSuffix();
  const gmailSession = `smoke-gmail-chatapps-${sessionSuffix}`;
  const linearSession = `smoke-linear-chatapps-${sessionSuffix}`;
  const gcalSession = `smoke-gcal-chatapps-${sessionSuffix}`;
  const requiredPublishedTools =
    mode === "full"
      ? ["chatgpt_app_gmail", "chatgpt_app_linear", "chatgpt_app_google_calendar"]
      : mode === "write"
        ? ["chatgpt_app_google_calendar"]
        : ["chatgpt_app_gmail"];

  const integEnv = buildIntegrationEnv();
  const context: RunContext = {
    gatewayChild: null,
    startedGateway: false,
    tuiChildren: new Set(),
    cleanupStarted: false,
  };
  const removeSignalHandlers = installSignalHandlers(context);

  try {
    await prepareOutputDir();
    await requirePrereqs();
    await prepareIntegrationProfile(integEnv);
    await captureListToolsSummary(requiredPublishedTools, integEnv);

    if (mode === "write") {
      await runWriteActionCase("write-always", WRITE_ALWAYS_SUMMARY, integEnv);
      await runWriteActionCase("write-never", WRITE_NEVER_SUMMARY, integEnv);

      const demoFile = await generateShowboatDemo(mode);

      console.log(`demo_file=${demoFile}`);
      console.log(`artifacts_dir=${ROOT_DIR}`);
      return;
    }

    await startFreshGateway(context, integEnv);

    await runTuiCheck({
      session: gmailSession,
      message:
        "Use the Gmail app tools now. Summarize my most recent inbox email in 3 short bullets. Do not ask follow-up questions.",
      expectedTool: "chatgpt_app_gmail",
      logPath: GMAIL_LOG,
      outputPath: GMAIL_SUMMARY,
      context,
      integEnv,
    });

    if (mode === "full") {
      await runTuiCheck({
        session: linearSession,
        message:
          "Use the Linear app tools now. Find the Linear tasks assigned to me and summarize them in concise bullets. Do not use browser tools. Do not ask follow-up questions.",
        expectedTool: "chatgpt_app_linear",
        logPath: LINEAR_LOG,
        outputPath: LINEAR_SUMMARY,
        context,
        integEnv,
      });

      await runTuiCheck({
        session: gcalSession,
        message: buildGoogleCalendarPrompt(),
        expectedTool: "chatgpt_app_google_calendar",
        logPath: GCAL_LOG,
        outputPath: GCAL_SUMMARY,
        context,
        integEnv,
      });
    }

    const demoFile = await generateShowboatDemo(mode);

    console.log(`demo_file=${demoFile}`);
    console.log(`artifacts_dir=${ROOT_DIR}`);
  } finally {
    removeSignalHandlers();
    await cleanup(context);
  }
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
});
