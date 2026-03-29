import { describe, expect, it } from "vitest";
import { deriveChatgptAppsMcpUrl } from "./remote-codex-apps-client.js";

describe("deriveChatgptAppsMcpUrl", () => {
  it("derives the wham endpoint for chatgpt.com", () => {
    expect(deriveChatgptAppsMcpUrl("https://chatgpt.com")).toBe(
      "https://chatgpt.com/backend-api/wham/apps",
    );
  });

  it("derives the wham endpoint for chat.openai.com", () => {
    expect(deriveChatgptAppsMcpUrl("https://chat.openai.com/backend-api")).toBe(
      "https://chatgpt.com/backend-api/wham/apps",
    );
  });

  it("appends /apps when the base already contains /api/codex", () => {
    expect(deriveChatgptAppsMcpUrl("https://example.com/base/api/codex")).toBe(
      "https://example.com/base/api/codex/apps",
    );
  });

  it("appends /api/codex/apps for generic bases", () => {
    expect(deriveChatgptAppsMcpUrl("https://example.com/base")).toBe(
      "https://example.com/base/api/codex/apps",
    );
  });
});
