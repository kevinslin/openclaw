import { describe, expect, it } from "vitest";
import {
  buildDerivedAppsConfig,
  hashChatgptAppsConfig,
  resolveChatgptAppsConfig,
} from "./config.js";

describe("resolveChatgptAppsConfig", () => {
  it("applies defaults when openai-apps config is absent", () => {
    expect(resolveChatgptAppsConfig({})).toEqual({
      enabled: false,
      allowDestructiveActions: "never",
      appServer: {
        command: "codex",
        args: [],
      },
      connectors: {},
    });
  });

  it("normalizes app-server args and connector flags", () => {
    const config = resolveChatgptAppsConfig({
      enabled: true,
      allow_destructive_actions: "on-request",
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
    });

    expect(config.enabled).toBe(true);
    expect(config.allowDestructiveActions).toBe("on-request");
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
      allowDestructiveActions: "always",
      appServer: { command: "codex", args: [] },
      connectors: {
        "*": { enabled: true },
        slack: { enabled: false },
      },
    });

    expect(derived).toEqual({
      _default: {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
      },
      slack: {
        enabled: false,
        destructive_enabled: true,
        open_world_enabled: true,
      },
    });
  });

  it("omits optional null-valued fields from sidecar config entries", () => {
    const derived = buildDerivedAppsConfig({
      enabled: true,
      allowDestructiveActions: "always",
      appServer: { command: "codex", args: [] },
      connectors: {
        gmail: { enabled: true },
      },
    });

    expect(derived.gmail).toEqual({
      enabled: true,
      destructive_enabled: true,
      open_world_enabled: true,
    });
    expect("default_tools_approval_mode" in (derived.gmail ?? {})).toBe(false);
    expect("default_tools_enabled" in (derived.gmail ?? {})).toBe(false);
    expect("tools" in (derived.gmail ?? {})).toBe(false);
  });

  it("hashes identical normalized configs stably", () => {
    const first = resolveChatgptAppsConfig({
      enabled: true,
      connectors: { slack: { enabled: true } },
    });
    const second = resolveChatgptAppsConfig({
      enabled: true,
      connectors: { slack: {} },
    });

    expect(hashChatgptAppsConfig(first)).toBe(hashChatgptAppsConfig(second));
  });

  it("keeps destructive tools enabled in the sidecar config when configured to never allow them", () => {
    const derived = buildDerivedAppsConfig({
      enabled: true,
      allowDestructiveActions: "never",
      appServer: { command: "codex", args: [] },
      connectors: {
        "*": { enabled: true },
        gmail: { enabled: true },
      },
    });

    expect(derived).toEqual({
      _default: {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
      },
      gmail: {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
      },
    });
  });
});
