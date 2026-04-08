import type { protocol } from "codex-app-server-sdk";

type AppInfo = protocol.v2.AppInfo;

export type PersistedConnectorRecord = {
  connectorId: string;
  appId: string;
  appName: string;
  publishedName: string;
  appInvocationToken: string;
  description: string;
  pluginDisplayNames: string[];
  isAccessible: boolean;
  isEnabled: boolean;
};

const EXCLUDED_CONNECTOR_IDS = new Set([
  "collab",
  "connector_openai_general_agent",
  "general_agent",
]);

export function normalizeConnectorKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function normalizeAppInvocationToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function looksLikeOpaqueAppId(value: string): boolean {
  return value.startsWith("connector_") || value.startsWith("asdk_app_");
}

function firstNonEmpty(values: string[]): string | null {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

export function shouldExcludeConnectorId(connectorId: string | null | undefined): boolean {
  if (!connectorId) {
    return false;
  }
  return EXCLUDED_CONNECTOR_IDS.has(normalizeConnectorKey(connectorId));
}

export function deriveCanonicalConnectorId(app: AppInfo): string {
  if (!looksLikeOpaqueAppId(app.id)) {
    const normalizedId = normalizeConnectorKey(app.id);
    if (normalizedId) {
      return normalizedId;
    }
  }

  const normalizedName = normalizeConnectorKey(app.name);
  if (normalizedName) {
    return normalizedName;
  }

  for (const displayName of app.pluginDisplayNames) {
    const normalizedDisplayName = normalizeConnectorKey(displayName);
    if (normalizedDisplayName) {
      return normalizedDisplayName;
    }
  }

  const normalizedOpaqueId = normalizeConnectorKey(app.id).replace(/^(connector|asdk_app)_/, "");
  if (normalizedOpaqueId) {
    return `app_${normalizedOpaqueId}`;
  }

  throw new Error(`Could not derive canonical connector id for app: ${app.id}`);
}

function deriveConnectorCollisionSuffix(app: AppInfo): string {
  const normalizedAppId = normalizeConnectorKey(app.id);
  if (!normalizedAppId) {
    return "app";
  }
  const withoutOpaquePrefix = normalizedAppId.replace(/^(connector|asdk_app)_/, "");
  return withoutOpaquePrefix.slice(-12) || normalizedAppId;
}

export function deriveAppInvocationToken(app: AppInfo, connectorId: string): string {
  for (const candidate of [app.name, ...app.pluginDisplayNames, connectorId]) {
    const normalized = normalizeAppInvocationToken(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return "app";
}

export function deriveConnectorDisplayName(app: AppInfo, connectorId: string): string {
  return firstNonEmpty([app.name, ...app.pluginDisplayNames]) ?? connectorId;
}

export function deriveConnectorDescription(app: AppInfo, appName: string): string {
  const lead = app.description?.trim();
  return lead && lead.length > 0 ? lead : `Use ${appName} through ChatGPT apps.`;
}

export function deriveConnectorRecord(
  app: AppInfo,
  connectorId: string = deriveCanonicalConnectorId(app),
): PersistedConnectorRecord {
  const appName = deriveConnectorDisplayName(app, connectorId);

  return {
    connectorId,
    appId: app.id,
    appName,
    publishedName: `chatgpt_app_${connectorId}`,
    appInvocationToken: deriveAppInvocationToken(app, connectorId),
    description: deriveConnectorDescription(app, appName),
    pluginDisplayNames: [...app.pluginDisplayNames],
    isAccessible: app.isAccessible,
    isEnabled: app.isEnabled,
  };
}

export function deriveConnectorRecordsFromApps(apps: AppInfo[]): PersistedConnectorRecord[] {
  const appsWithCanonicalId = apps.map((app, index) => ({
    app,
    index,
    canonicalConnectorId: deriveCanonicalConnectorId(app),
  }));
  const entriesByCanonicalId = new Map<
    string,
    Array<{ app: AppInfo; index: number; canonicalConnectorId: string }>
  >();

  for (const entry of appsWithCanonicalId) {
    const group = entriesByCanonicalId.get(entry.canonicalConnectorId);
    if (group) {
      group.push(entry);
      continue;
    }
    entriesByCanonicalId.set(entry.canonicalConnectorId, [entry]);
  }

  const connectorIdByIndex = new Map<number, string>();
  const seenConnectorIds = new Set<string>();

  for (const [canonicalConnectorId, group] of entriesByCanonicalId) {
    const collisionGroup = [...group].sort((left, right) => {
      const appIdComparison = left.app.id.localeCompare(right.app.id);
      if (appIdComparison !== 0) {
        return appIdComparison;
      }
      return left.index - right.index;
    });

    for (const [position, entry] of collisionGroup.entries()) {
      const connectorId =
        position === 0
          ? canonicalConnectorId
          : `${canonicalConnectorId}_${deriveConnectorCollisionSuffix(entry.app)}`;
      if (seenConnectorIds.has(connectorId)) {
        throw new Error(
          `Could not derive unique connector id from app/list for app: ${entry.app.id} (${connectorId})`,
        );
      }
      seenConnectorIds.add(connectorId);
      connectorIdByIndex.set(entry.index, connectorId);
    }
  }

  const records: PersistedConnectorRecord[] = [];
  for (const entry of appsWithCanonicalId) {
    const connectorId = connectorIdByIndex.get(entry.index);
    if (!connectorId) {
      throw new Error(`Missing derived connector id for app: ${entry.app.id}`);
    }
    records.push(deriveConnectorRecord(entry.app, connectorId));
  }

  return records;
}

export function isPersistedConnectorRecord(value: unknown): value is PersistedConnectorRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.connectorId === "string" &&
    typeof record.appId === "string" &&
    typeof record.appName === "string" &&
    typeof record.publishedName === "string" &&
    typeof record.appInvocationToken === "string" &&
    typeof record.description === "string" &&
    Array.isArray(record.pluginDisplayNames) &&
    record.pluginDisplayNames.every((entry) => typeof entry === "string") &&
    typeof record.isAccessible === "boolean" &&
    typeof record.isEnabled === "boolean"
  );
}

export function assertValidPersistedConnectorRecord(
  record: PersistedConnectorRecord,
): PersistedConnectorRecord {
  if (!record.connectorId.trim()) {
    throw new Error("Connector snapshot record is missing connectorId");
  }
  if (!record.appId.trim()) {
    throw new Error(`Connector snapshot record ${record.connectorId} is missing appId`);
  }
  if (!record.appName.trim()) {
    throw new Error(`Connector snapshot record ${record.connectorId} is missing appName`);
  }
  if (record.publishedName !== `chatgpt_app_${record.connectorId}`) {
    throw new Error(
      `Connector snapshot record ${record.connectorId} has mismatched publishedName: ${record.publishedName}`,
    );
  }
  if (!record.appInvocationToken.trim()) {
    throw new Error(
      `Connector snapshot record ${record.connectorId} is missing appInvocationToken`,
    );
  }
  if (!record.description.trim()) {
    throw new Error(`Connector snapshot record ${record.connectorId} is missing description`);
  }
  return record;
}
