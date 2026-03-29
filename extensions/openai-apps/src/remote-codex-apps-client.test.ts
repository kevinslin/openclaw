import { describe, expect, it } from "vitest";
import { deriveChatgptAppsMcpUrl } from "./remote-codex-apps-client.js";

describe("deriveChatgptAppsMcpUrl", () => {
  it("derives the hardcoded ChatGPT apps endpoint", () => {
    expect(deriveChatgptAppsMcpUrl()).toBe("https://chatgpt.com/backend-api/wham/apps");
  });
});
