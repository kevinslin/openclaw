import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "../../../src/config/config.js";

describe("openai-apps bundle config validation", () => {
  it("accepts bundle-owned app config under plugins.entries.openai-apps.config", () => {
    const result = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        entries: {
          "openai-apps": {
            enabled: true,
            config: {
              enabled: true,
              allow_destructive_actions: "always",
              connectors: {
                gmail: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });
});
