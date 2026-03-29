import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type ResolvedGatewayRuntimeContext = {
  stateDir: string;
  agentDir: string;
};

function normalizeOptionalString(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function deriveStateDirFromAgentDir(agentDir: string | undefined): string | null {
  const normalizedAgentDir = normalizeOptionalString(agentDir);
  if (!normalizedAgentDir) {
    return null;
  }

  const marker = `${path.sep}agents${path.sep}`;
  const markerIndex = normalizedAgentDir.lastIndexOf(marker);
  if (markerIndex <= 0) {
    return null;
  }
  return normalizedAgentDir.slice(0, markerIndex);
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    return typeof raw.pid === "number" && Number.isFinite(raw.pid) ? raw.pid : null;
  } catch {
    return null;
  }
}

async function resolveGatewayRuntimeContextFromLocks(params: {
  homeDir: string;
  parentPid: number;
}): Promise<ResolvedGatewayRuntimeContext | null> {
  if (!Number.isFinite(params.parentPid) || params.parentPid <= 1) {
    return null;
  }

  let homeEntries: string[] = [];
  try {
    homeEntries = await readdir(params.homeDir);
  } catch {
    return null;
  }

  const candidateStateDirs = homeEntries
    .filter((entry) => entry === ".openclaw" || entry.startsWith(".openclaw-"))
    .map((entry) => path.join(params.homeDir, entry));

  for (const stateDir of candidateStateDirs) {
    const agentsDir = path.join(stateDir, "agents");
    let agentIds: string[] = [];
    try {
      agentIds = await readdir(agentsDir);
    } catch {
      continue;
    }

    for (const agentId of agentIds) {
      const sessionsDir = path.join(agentsDir, agentId, "sessions");
      let sessionEntries: string[] = [];
      try {
        sessionEntries = await readdir(sessionsDir);
      } catch {
        continue;
      }

      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.endsWith(".jsonl.lock")) {
          continue;
        }

        const lockPath = path.join(sessionsDir, sessionEntry);
        const lockPid = await readLockPid(lockPath);
        if (lockPid !== params.parentPid) {
          continue;
        }

        return {
          stateDir,
          agentDir: path.join(agentsDir, agentId, "agent"),
        };
      }
    }
  }

  return null;
}

async function resolveGatewayRuntimeContextFromRecentSessions(params: {
  homeDir: string;
}): Promise<ResolvedGatewayRuntimeContext | null> {
  let homeEntries: string[] = [];
  try {
    homeEntries = await readdir(params.homeDir);
  } catch {
    return null;
  }

  const candidateStateDirs = homeEntries
    .filter((entry) => entry === ".openclaw" || entry.startsWith(".openclaw-"))
    .map((entry) => path.join(params.homeDir, entry));

  let bestMatch: (ResolvedGatewayRuntimeContext & { updatedAt: number }) | null = null;

  for (const stateDir of candidateStateDirs) {
    const agentsDir = path.join(stateDir, "agents");
    let agentIds: string[] = [];
    try {
      agentIds = await readdir(agentsDir);
    } catch {
      continue;
    }

    for (const agentId of agentIds) {
      const sessionsIndexPath = path.join(agentsDir, agentId, "sessions", "sessions.json");
      let updatedAt = 0;
      try {
        updatedAt = (await stat(sessionsIndexPath)).mtimeMs;
      } catch {
        continue;
      }

      if (!Number.isFinite(updatedAt)) {
        continue;
      }

      if (!bestMatch || updatedAt > bestMatch.updatedAt) {
        bestMatch = {
          stateDir,
          agentDir: path.join(agentsDir, agentId, "agent"),
          updatedAt,
        };
      }
    }
  }

  return bestMatch
    ? {
        stateDir: bestMatch.stateDir,
        agentDir: bestMatch.agentDir,
      }
    : null;
}

export async function resolveOpenaiAppsRuntimeEnv(
  env: NodeJS.ProcessEnv,
  parentPid: number = process.ppid,
): Promise<NodeJS.ProcessEnv> {
  const explicitStateDir = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  const explicitConfigPath = normalizeOptionalString(env.OPENCLAW_CONFIG_PATH);
  const explicitAgentDir = normalizeOptionalString(env.OPENCLAW_AGENT_DIR);

  const nextEnv: NodeJS.ProcessEnv = { ...env };
  if (explicitStateDir && explicitConfigPath && explicitAgentDir) {
    return nextEnv;
  }

  const homeDir = normalizeOptionalString(env.HOME) ?? os.homedir();
  const stateDirFromAgent = deriveStateDirFromAgentDir(explicitAgentDir);
  const configDir = explicitConfigPath ? path.dirname(explicitConfigPath) : null;
  const lockContext = await resolveGatewayRuntimeContextFromLocks({
    homeDir,
    parentPid,
  });
  const recentSessionContext =
    lockContext === null ? await resolveGatewayRuntimeContextFromRecentSessions({ homeDir }) : null;

  const resolvedStateDir =
    explicitStateDir ??
    stateDirFromAgent ??
    configDir ??
    lockContext?.stateDir ??
    recentSessionContext?.stateDir ??
    path.join(homeDir, ".openclaw");
  const resolvedAgentDir =
    explicitAgentDir ?? lockContext?.agentDir ?? recentSessionContext?.agentDir;
  const resolvedConfigPath = explicitConfigPath ?? path.join(resolvedStateDir, "openclaw.json");

  nextEnv.OPENCLAW_STATE_DIR = resolvedStateDir;
  nextEnv.OPENCLAW_CONFIG_PATH = resolvedConfigPath;
  if (resolvedAgentDir) {
    nextEnv.OPENCLAW_AGENT_DIR = resolvedAgentDir;
  }
  return nextEnv;
}
