import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { protocol } from "codex-app-server-sdk";
import type { ChatgptAppsStatePaths } from "./state-paths.js";

type AppInfo = protocol.v2.AppInfo;
type McpServerStatus = protocol.v2.McpServerStatus;

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

export type PersistedConnectorSnapshot = {
  version: number;
  fetchedAt: string;
  projectedAt: string;
  accountId: string;
  authIdentityKey: string;
  configHash: string;
  baseUrlHash: string;
  inventory: AppInfo[];
  statuses: McpServerStatus[];
};

export type RefreshDebugState = {
  updatedAt: string;
  status: "success" | "failure";
  source?: "cache" | "refresh";
  message?: string;
  accountId?: string;
};

export type SnapshotInputs = {
  accountId: string;
  authIdentityKey: string;
  configHash: string;
  baseUrlHash: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildAuthIdentityKey(identity: { email?: string; profileName?: string }): string {
  return identity.email ?? identity.profileName ?? "unknown";
}

export function computeSnapshotKey(snapshot: PersistedConnectorSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        fetchedAt: snapshot.fetchedAt,
        accountId: snapshot.accountId,
        configHash: snapshot.configHash,
        baseUrlHash: snapshot.baseUrlHash,
        inventory: snapshot.inventory.map((app) => ({
          id: app.id,
          isAccessible: app.isAccessible,
          isEnabled: app.isEnabled,
        })),
        statuses: snapshot.statuses.map((status) => ({
          name: status.name,
          tools: Object.keys(status.tools ?? {}).sort(),
        })),
      }),
    )
    .digest("hex");
}

export async function readPersistedSnapshot(
  snapshotPath: string,
): Promise<PersistedConnectorSnapshot | null> {
  try {
    const raw = JSON.parse(await readFile(snapshotPath, "utf8")) as unknown;
    if (!isRecord(raw)) {
      return null;
    }
    if (
      typeof raw.version !== "number" ||
      typeof raw.fetchedAt !== "string" ||
      typeof raw.projectedAt !== "string" ||
      typeof raw.accountId !== "string" ||
      typeof raw.authIdentityKey !== "string" ||
      typeof raw.configHash !== "string" ||
      typeof raw.baseUrlHash !== "string" ||
      !Array.isArray(raw.inventory) ||
      !Array.isArray(raw.statuses)
    ) {
      return null;
    }
    return raw as PersistedConnectorSnapshot;
  } catch {
    return null;
  }
}

export function isSnapshotFresh(params: {
  snapshot: PersistedConnectorSnapshot;
  inputs: SnapshotInputs;
  now?: number;
  ttlMs?: number;
}): boolean {
  const now = params.now ?? Date.now();
  const ttlMs = params.ttlMs ?? SNAPSHOT_TTL_MS;
  const fetchedAt = parseIsoTimestamp(params.snapshot.fetchedAt);
  if (params.snapshot.version !== SNAPSHOT_VERSION || fetchedAt === null) {
    return false;
  }
  if (now - fetchedAt > ttlMs) {
    return false;
  }
  return (
    params.snapshot.accountId === params.inputs.accountId &&
    params.snapshot.authIdentityKey === params.inputs.authIdentityKey &&
    params.snapshot.configHash === params.inputs.configHash &&
    params.snapshot.baseUrlHash === params.inputs.baseUrlHash
  );
}

export async function writePersistedSnapshot(params: {
  statePaths: ChatgptAppsStatePaths;
  snapshot: PersistedConnectorSnapshot;
}): Promise<void> {
  await mkdir(params.statePaths.rootDir, { recursive: true });
  const tempPath = path.join(
    params.statePaths.rootDir,
    `connectors.snapshot.${randomUUID()}.tmp.json`,
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(params.snapshot, null, 2)}\n`, "utf8");
    await rename(tempPath, params.statePaths.snapshotPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function writeRefreshDebug(params: {
  statePaths: ChatgptAppsStatePaths;
  debug: RefreshDebugState;
}): Promise<void> {
  await mkdir(params.statePaths.rootDir, { recursive: true });
  await writeFile(params.statePaths.refreshDebugPath, `${JSON.stringify(params.debug, null, 2)}\n`);
}
