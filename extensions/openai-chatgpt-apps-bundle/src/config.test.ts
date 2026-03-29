import { describe, expect, it } from "vitest";
import {
  buildDerivedAppsConfig,
  hashChatgptAppsConfig,
  resolveChatgptAppsConfig,
} from "./config.js";

describe("resolveChatgptAppsConfig", () => {
  it("applies defaults when chatgpt apps config is absent", () => {
    expect(resolveChatgptAppsConfig({})).toEqual({
      enabled: false,
      chatgptBaseUrl: "https://chatgpt.com",
      appServer: {
        command: "codex",
        args: [],
      },
      linking: {
        enabled: false,
        waitTimeoutMs: 60_000,
        pollIntervalMs: 3_000,
      },
      connectors: {},
    });
  });

  it("normalizes app-server args and connector flags", () => {
    const config = resolveChatgptAppsConfig({
      chatgptApps: {
        enabled: true,
        appServer: {
          command: "codex-dev",
          args: ["app-server", "--analytics-default-enabled", "--foo"],
        },
        connectors: {
          Slack: {
            enabled: false,
          },
          Gmail: {},
        },
      },
    });

    expect(config.enabled).toBe(true);
    expect(config.appServer).toEqual({
      command: "codex-dev",
      args: ["--foo"],
    });
    expect(config.connectors).toEqual({
      Slack: { enabled: false },
      Gmail: { enabled: true },
    });
  });
});

describe("buildDerivedAppsConfig", () => {
  it("mirrors wildcard and connector enablement into the sidecar config", () => {
    const derived = buildDerivedAppsConfig({
      enabled: true,
      chatgptBaseUrl: "https://chatgpt.com",
      appServer: { command: "codex", args: [] },
      linking: {
        enabled: false,
        waitTimeoutMs: 60_000,
        pollIntervalMs: 3_000,
      },
      connectors: {
        "*": { enabled: true },
        slack: { enabled: false },
      },
    });

    expect(derived).toEqual({
      _default: {
        enabled: true,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      "*": {
        enabled: true,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      slack: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    });
  });

  it("omits optional null-valued fields from sidecar config entries", () => {
    const derived = buildDerivedAppsConfig({
      enabled: true,
      chatgptBaseUrl: "https://chatgpt.com",
      appServer: { command: "codex", args: [] },
      linking: {
        enabled: false,
        waitTimeoutMs: 60_000,
        pollIntervalMs: 3_000,
      },
      connectors: {
        gmail: { enabled: true },
      },
    });

    expect(derived.gmail).toEqual({
      enabled: true,
      destructive_enabled: false,
      open_world_enabled: false,
    });
    expect("default_tools_approval_mode" in (derived.gmail ?? {})).toBe(false);
    expect("default_tools_enabled" in (derived.gmail ?? {})).toBe(false);
    expect("tools" in (derived.gmail ?? {})).toBe(false);
  });

  it("hashes identical normalized configs stably", () => {
    const first = resolveChatgptAppsConfig({
      chatgptApps: {
        enabled: true,
        connectors: { slack: { enabled: true } },
      },
    });
    const second = resolveChatgptAppsConfig({
      chatgptApps: {
        enabled: true,
        connectors: { slack: {} },
      },
    });

    expect(hashChatgptAppsConfig(first)).toBe(hashChatgptAppsConfig(second));
  });
});
