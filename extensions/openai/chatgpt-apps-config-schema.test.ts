import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "../../src/config/config.js";

describe("openai plugin manifest chatgpt apps schema", () => {
  it("declares the chatgptApps config surface", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema?: {
        properties?: Record<string, unknown>;
      };
    };

    expect(manifest.configSchema?.properties?.chatgptApps).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
        },
        chatgptBaseUrl: {
          type: "string",
          minLength: 1,
        },
        appServer: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: {
              type: "string",
              minLength: 1,
            },
            args: {
              type: "array",
              items: {
                type: "string",
              },
            },
          },
        },
        linking: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: {
              type: "boolean",
            },
            waitTimeoutMs: {
              type: "number",
              minimum: 1,
            },
            pollIntervalMs: {
              type: "number",
              minimum: 1,
            },
          },
        },
        connectors: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: {
                type: "boolean",
              },
            },
          },
        },
      },
    });
  });

  it("accepts chatgptApps config through plugin config validation", () => {
    const result = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        entries: {
          openai: {
            enabled: true,
            config: {
              chatgptApps: {
                enabled: true,
                chatgptBaseUrl: "https://chat.openai.com",
                connectors: {
                  gmail: {
                    enabled: true,
                  },
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
