#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEV_HOME_DIR = path.join(os.homedir(), ".openclaw-dev");
const DEV_CONFIG_PATH = path.join(DEV_HOME_DIR, "openclaw.json");
const MAIN_HOME_DIR = path.join(os.homedir(), ".openclaw");
const MAIN_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const DEV_DENYLIST = ["sglang", "vllm"];
const MAIN_PLUGIN_ENTRY_IDS = ["openai", "openclaw-chatgpt-apps-bundle"];
const CHATGPT_APPS_RUNTIME_RELATIVE_FILES = [
  path.join("plugin-runtimes", "openai-chatgpt-apps", "connectors.snapshot.json"),
  path.join("plugin-runtimes", "openai-chatgpt-apps", "refresh-debug.json"),
];

function readConfig() {
  if (!fs.existsSync(DEV_CONFIG_PATH)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(DEV_CONFIG_PATH, "utf8"));
}

function readMainConfig() {
  if (!fs.existsSync(MAIN_CONFIG_PATH)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(MAIN_CONFIG_PATH, "utf8"));
}

function writeConfig(config) {
  fs.mkdirSync(DEV_HOME_DIR, { recursive: true });
  fs.writeFileSync(DEV_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function ensureDevDenylist(config) {
  const plugins = config.plugins && typeof config.plugins === "object" ? config.plugins : {};
  const deny = normalizeStringList(plugins.deny);
  const nextDeny = [...new Set([...deny, ...DEV_DENYLIST])].toSorted((left, right) =>
    left.localeCompare(right),
  );
  return {
    ...config,
    plugins: {
      ...plugins,
      deny: nextDeny,
    },
  };
}

function projectMainProfile(config, mainConfig) {
  const next = { ...config };
  if (mainConfig.auth && typeof mainConfig.auth === "object") {
    next.auth = structuredClone(mainConfig.auth);
  }

  const mainAgentDefaults =
    mainConfig.agents &&
    typeof mainConfig.agents === "object" &&
    mainConfig.agents.defaults &&
    typeof mainConfig.agents.defaults === "object"
      ? mainConfig.agents.defaults
      : undefined;
  const currentAgents = next.agents && typeof next.agents === "object" ? next.agents : {};
  const currentDefaults =
    currentAgents.defaults && typeof currentAgents.defaults === "object"
      ? currentAgents.defaults
      : {};
  next.agents = {
    ...currentAgents,
    defaults: {
      ...currentDefaults,
      ...(mainAgentDefaults && typeof mainAgentDefaults === "object"
        ? {
            ...(mainAgentDefaults.model !== undefined ? { model: mainAgentDefaults.model } : {}),
            ...(mainAgentDefaults.models !== undefined ? { models: mainAgentDefaults.models } : {}),
            ...(mainAgentDefaults.thinkingDefault !== undefined
              ? { thinkingDefault: mainAgentDefaults.thinkingDefault }
              : {}),
            ...(mainAgentDefaults.compaction !== undefined
              ? { compaction: mainAgentDefaults.compaction }
              : {}),
          }
        : {}),
    },
  };

  const currentPlugins = next.plugins && typeof next.plugins === "object" ? next.plugins : {};
  const currentEntries =
    currentPlugins.entries && typeof currentPlugins.entries === "object"
      ? currentPlugins.entries
      : {};
  const mainPlugins =
    mainConfig.plugins && typeof mainConfig.plugins === "object" ? mainConfig.plugins : {};
  const mainEntries =
    mainPlugins.entries && typeof mainPlugins.entries === "object" ? mainPlugins.entries : {};
  const projectedEntries = { ...currentEntries };
  for (const pluginId of MAIN_PLUGIN_ENTRY_IDS) {
    if (mainEntries[pluginId] !== undefined) {
      projectedEntries[pluginId] = structuredClone(mainEntries[pluginId]);
    }
  }
  next.plugins = {
    ...currentPlugins,
    entries: projectedEntries,
  };

  return next;
}

function syncRuntimeFileFromMain(relativePath) {
  const mainPath = path.join(MAIN_HOME_DIR, relativePath);
  if (!fs.existsSync(mainPath)) {
    return false;
  }

  const devPath = path.join(DEV_HOME_DIR, relativePath);
  const mainStat = fs.statSync(mainPath);
  const devStat = fs.existsSync(devPath) ? fs.statSync(devPath) : null;
  if (devStat && devStat.mtimeMs >= mainStat.mtimeMs) {
    return false;
  }

  fs.mkdirSync(path.dirname(devPath), { recursive: true });
  fs.copyFileSync(mainPath, devPath);
  return true;
}

function syncChatgptAppsRuntimeFromMain() {
  const copied = CHATGPT_APPS_RUNTIME_RELATIVE_FILES.filter((relativePath) =>
    syncRuntimeFileFromMain(relativePath),
  );
  if (copied.length === 0) {
    return;
  }

  console.error(`[openclaw] synced dev ChatGPT apps runtime from main: ${copied.join(", ")}`);
}

const currentConfig = readConfig();
const mainConfig = readMainConfig();
const nextConfig = ensureDevDenylist(projectMainProfile(currentConfig, mainConfig));

if (JSON.stringify(currentConfig) !== JSON.stringify(nextConfig)) {
  writeConfig(nextConfig);
  console.error(
    `[openclaw] prepared dev profile at ${DEV_CONFIG_PATH} with auth, agent model, and ChatGPT apps config mirrored from main; plugins.deny=${DEV_DENYLIST.join(",")}`,
  );
}

syncChatgptAppsRuntimeFromMain();
