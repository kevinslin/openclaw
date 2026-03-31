import type { protocol } from "codex-app-server-sdk";
import { describe, expect, it } from "vitest";
import {
  deriveCanonicalConnectorId,
  deriveConnectorRecord,
  deriveConnectorRecordsFromApps,
} from "./connector-record.js";
import { computeSnapshotKey } from "./snapshot-cache.js";

type AppInfo = protocol.v2.AppInfo;

function createApp(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    id: "asdk_app_gmail",
    name: "Gmail",
    description: "Read mail.",
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: ["Gmail"],
    ...overrides,
  };
}

describe("connector-record", () => {
  it("prefers a non-opaque app id for the canonical connector id", () => {
    expect(
      deriveCanonicalConnectorId(
        createApp({
          id: "google-calendar",
          name: "Google Calendar",
        }),
      ),
    ).toBe("google_calendar");
  });

  it("falls back to app name and plugin display names for the canonical connector id", () => {
    expect(
      deriveCanonicalConnectorId(
        createApp({
          id: "asdk_app_123",
          name: "Google Calendar",
        }),
      ),
    ).toBe("google_calendar");

    expect(
      deriveCanonicalConnectorId(
        createApp({
          id: "asdk_app_456",
          name: "",
          pluginDisplayNames: ["Linear"],
        }),
      ),
    ).toBe("linear");

    expect(
      deriveCanonicalConnectorId(
        createApp({
          id: "asdk_app_6944c51054388191a007431b1f1b71b2",
          name: "",
          pluginDisplayNames: [],
        }),
      ),
    ).toBe("app_6944c51054388191a007431b1f1b71b2");
  });

  it("derives the published tool contract from one app", () => {
    expect(
      deriveConnectorRecord(
        createApp({
          id: "asdk_app_gmail",
          name: "Gmail",
          description: "",
          pluginDisplayNames: ["Gmail"],
        }),
      ),
    ).toEqual({
      connectorId: "gmail",
      appId: "asdk_app_gmail",
      appName: "Gmail",
      publishedName: "chatgpt_app_gmail",
      appInvocationToken: "gmail",
      description: "Use Gmail through ChatGPT apps.",
      pluginDisplayNames: ["Gmail"],
      isAccessible: true,
      isEnabled: true,
    });
  });

  it("adds a stable suffix when two apps collapse to the same canonical connector id", () => {
    const apps = [
      createApp({ id: "connector_37316be7febe4224b3d31465bae4dbd7", name: "Notion" }),
      createApp({ id: "connector_1ee51bd730c272434e1b17c46f8a2397", name: "Notion" }),
    ];

    const forward = deriveConnectorRecordsFromApps(apps).map((record) => ({
      appId: record.appId,
      connectorId: record.connectorId,
      publishedName: record.publishedName,
    }));
    const reverse = deriveConnectorRecordsFromApps([...apps].reverse()).map((record) => ({
      appId: record.appId,
      connectorId: record.connectorId,
      publishedName: record.publishedName,
    }));

    const sortByAppId = <T extends { appId: string }>(records: T[]) =>
      [...records].sort((left, right) => left.appId.localeCompare(right.appId));

    expect(sortByAppId(forward)).toEqual([
      {
        appId: "connector_1ee51bd730c272434e1b17c46f8a2397",
        connectorId: "notion",
        publishedName: "chatgpt_app_notion",
      },
      {
        appId: "connector_37316be7febe4224b3d31465bae4dbd7",
        connectorId: "notion_1465bae4dbd7",
        publishedName: "chatgpt_app_notion_1465bae4dbd7",
      },
    ]);
    expect(sortByAppId(reverse)).toEqual(sortByAppId(forward));
  });

  it("hashes connector-level publication fields without any status dependency", () => {
    const base = {
      version: 2,
      fetchedAt: "2026-03-30T18:00:00.000Z",
      projectedAt: "2026-03-30T18:00:00.000Z",
      accountId: "acct_123",
      authIdentityKey: "user@example.com",
      connectors: [deriveConnectorRecord(createApp())],
    };

    const keyA = computeSnapshotKey(base);
    const keyB = computeSnapshotKey({
      ...base,
      connectors: [{ ...base.connectors[0], description: "Different description" }],
    });

    expect(keyA).not.toBe(keyB);
  });
});
