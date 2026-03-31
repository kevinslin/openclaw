#!/usr/bin/env -S node --import tsx

import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type CaseName = "write-always" | "write-never";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const INTEG_DIR = path.dirname(SCRIPT_PATH);
const EXTENSION_DIR = path.resolve(INTEG_DIR, "..");
const REPO_DIR = path.resolve(EXTENSION_DIR, "..", "..");
const TIME_ZONE = "America/Los_Angeles";
const GOOGLE_CALENDAR_TOOL = "chatgpt_app_google_calendar";

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  const explicitPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

async function loadConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return isRecord(raw) ? raw : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function setAllowDestructiveActions(
  config: Record<string, unknown>,
  mode: "always" | "never",
): Record<string, unknown> {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  config.plugins = plugins;

  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  plugins.entries = entries;

  const openaiApps = isRecord(entries["openai-apps"]) ? entries["openai-apps"] : {};
  entries["openai-apps"] = openaiApps;
  openaiApps.enabled = true;

  const appsConfig = isRecord(openaiApps.config) ? openaiApps.config : {};
  openaiApps.config = appsConfig;
  appsConfig.enabled = true;
  appsConfig.allow_destructive_actions = mode;

  const connectors = isRecord(appsConfig.connectors) ? appsConfig.connectors : {};
  appsConfig.connectors = connectors;
  const wildcard = isRecord(connectors["*"]) ? connectors["*"] : {};
  connectors["*"] = wildcard;
  wildcard.enabled = true;

  return config;
}

function toStrictEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function extractText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return "";
  }

  return result.content
    .filter(
      (item): item is { type: string; text: string } =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function buildEventWindow(): {
  title: string;
  dateLabel: string;
  startTimeLabel: string;
  endTimeLabel: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = Number.parseInt(parts.find((part) => part.type === "year")?.value ?? "", 10);
  const month = Number.parseInt(parts.find((part) => part.type === "month")?.value ?? "", 10);
  const day = Number.parseInt(parts.find((part) => part.type === "day")?.value ?? "", 10);

  const localDate = new Date(Date.UTC(year, month - 1, day));
  localDate.setUTCDate(localDate.getUTCDate() + 1);

  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(localDate);

  const title = `OpenClaw Write Integ ${Date.now()}`;
  return {
    title,
    dateLabel,
    startTimeLabel: "11:00 AM",
    endTimeLabel: "11:15 AM",
  };
}

async function callCalendarTool(
  client: Client,
  request: string,
): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({
    name: GOOGLE_CALENDAR_TOOL,
    arguments: { request },
  });
  return {
    isError: result.isError === true,
    text: extractText(result),
  };
}

async function main(): Promise<void> {
  const caseName = process.argv[2];
  if (caseName !== "write-always" && caseName !== "write-never") {
    fail("usage: verify-destructive-action-case.ts [write-always|write-never]");
  }

  const env = { ...process.env };
  const configPath = resolveConfigPath(env);
  const config = setAllowDestructiveActions(
    await loadConfig(configPath),
    caseName === "write-always" ? "always" : "never",
  );
  await writeConfig(configPath, config);

  const transport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", "./extensions/openai-apps/src/server.ts"],
    cwd: REPO_DIR,
    env: toStrictEnv(env),
  });
  const client = new Client({ name: "chatapps-write-integ", version: "0.1.0" });

  const event = buildEventWindow();
  const createPrompt = [
    "Use the Google Calendar app tools now.",
    `Create a Google Calendar event titled "${event.title}" on ${event.dateLabel} from ${event.startTimeLabel} to ${event.endTimeLabel} in ${TIME_ZONE}.`,
    "Return only a concise confirmation with the event title and start time.",
    "Do not ask follow-up questions.",
  ].join(" ");
  const verifyPrompt = [
    "Use the Google Calendar app tools now.",
    `Find the Google Calendar event titled "${event.title}" on ${event.dateLabel} in ${TIME_ZONE}.`,
    "Return only the event title and start time if it exists.",
    "Do not ask follow-up questions.",
  ].join(" ");
  const deletePrompt = [
    "Use the Google Calendar app tools now.",
    `Delete the Google Calendar event titled "${event.title}" on ${event.dateLabel} from ${event.startTimeLabel} to ${event.endTimeLabel} in ${TIME_ZONE}.`,
    "Return only whether deletion succeeded.",
    "Do not ask follow-up questions.",
  ].join(" ");

  let cleanupText: string | null = null;

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    if (!listed.tools.some((tool) => tool.name === GOOGLE_CALENDAR_TOOL)) {
      fail(`missing published tool: ${GOOGLE_CALENDAR_TOOL}`);
    }

    const createResult = await callCalendarTool(client, createPrompt);

    if (caseName === "write-never") {
      if (createResult.isError) {
        fail(`write-never returned MCP error: ${createResult.text}`);
      }
      if (!createResult.text.includes("allowDestructiveActions=never")) {
        fail(`write-never did not auto-decline destructive action: ${createResult.text}`);
      }
      process.stdout.write(
        `${JSON.stringify(
          {
            caseName,
            passed: true,
            policy: "never",
            response: createResult.text,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    if (createResult.isError) {
      fail(`write-always returned MCP error: ${createResult.text}`);
    }

    let verifyResult = await callCalendarTool(client, verifyPrompt);
    if (!verifyResult.text.includes(event.title)) {
      await sleep(2_000);
      verifyResult = await callCalendarTool(client, verifyPrompt);
    }
    if (verifyResult.isError || !verifyResult.text.includes(event.title)) {
      fail(`write-always did not verify created event: ${verifyResult.text}`);
    }

    const cleanupResult = await callCalendarTool(client, deletePrompt);
    cleanupText = cleanupResult.text || null;
    if (cleanupResult.isError) {
      fail(`write-always cleanup returned MCP error: ${cleanupResult.text}`);
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          caseName,
          passed: true,
          policy: "always",
          title: event.title,
          created: createResult.text,
          verified: verifyResult.text,
          cleanedUp: cleanupResult.text,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await client.close().catch(() => {});
    if (cleanupText === null && caseName === "write-always") {
      process.stderr.write(
        `cleanup_not_confirmed title="${event.title}" date="${event.dateLabel}" start="${event.startTimeLabel}" timezone="${TIME_ZONE}"\n`,
      );
    }
  }
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
});
