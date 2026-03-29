import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenaiAppsRuntimeEnv } from "./runtime-env.js";

describe("resolveOpenaiAppsRuntimeEnv", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (tempDir) => {
        await import("node:fs/promises").then(({ rm }) =>
          rm(tempDir, { force: true, recursive: true }),
        );
      }),
    );
    tempDirs.length = 0;
  });

  it("preserves explicit OpenClaw runtime env overrides", async () => {
    const env = await resolveOpenaiAppsRuntimeEnv({
      HOME: "/tmp/home",
      OPENCLAW_STATE_DIR: "/tmp/state",
      OPENCLAW_CONFIG_PATH: "/tmp/state/openclaw.json",
      OPENCLAW_AGENT_DIR: "/tmp/state/agents/dev/agent",
    });

    expect(env.OPENCLAW_STATE_DIR).toBe("/tmp/state");
    expect(env.OPENCLAW_CONFIG_PATH).toBe("/tmp/state/openclaw.json");
    expect(env.OPENCLAW_AGENT_DIR).toBe("/tmp/state/agents/dev/agent");
  });

  it("derives the active profile env from the parent gateway session lock", async () => {
    const homeDir = await import("node:fs/promises").then(
      async ({ mkdtemp }) => await mkdtemp(path.join(os.tmpdir(), "openai-apps-runtime-env-")),
    );
    tempDirs.push(homeDir);

    const stateDir = path.join(homeDir, ".openclaw-dev");
    const sessionsDir = path.join(stateDir, "agents", "dev", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, "gateway-session.jsonl.lock"),
      `${JSON.stringify({ pid: 424242 }, null, 2)}\n`,
      "utf8",
    );

    const env = await resolveOpenaiAppsRuntimeEnv(
      {
        HOME: homeDir,
      },
      424242,
    );

    expect(env.OPENCLAW_STATE_DIR).toBe(stateDir);
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join(stateDir, "openclaw.json"));
    expect(env.OPENCLAW_AGENT_DIR).toBe(path.join(stateDir, "agents", "dev", "agent"));
  });

  it("falls back to the most recently active profile session index", async () => {
    const homeDir = await import("node:fs/promises").then(
      async ({ mkdtemp }) => await mkdtemp(path.join(os.tmpdir(), "openai-apps-runtime-recent-")),
    );
    tempDirs.push(homeDir);

    const mainSessionsDir = path.join(homeDir, ".openclaw", "agents", "main", "sessions");
    const devSessionsDir = path.join(homeDir, ".openclaw-dev", "agents", "dev", "sessions");
    await mkdir(mainSessionsDir, { recursive: true });
    await mkdir(devSessionsDir, { recursive: true });
    await writeFile(path.join(mainSessionsDir, "sessions.json"), "{}\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(devSessionsDir, "sessions.json"), "{}\n", "utf8");

    const env = await resolveOpenaiAppsRuntimeEnv(
      {
        HOME: homeDir,
      },
      1,
    );

    expect(env.OPENCLAW_STATE_DIR).toBe(path.join(homeDir, ".openclaw-dev"));
    expect(env.OPENCLAW_AGENT_DIR).toBe(
      path.join(homeDir, ".openclaw-dev", "agents", "dev", "agent"),
    );
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join(homeDir, ".openclaw-dev", "openclaw.json"));
  });
});
