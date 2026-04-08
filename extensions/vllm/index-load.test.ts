import { describe, expect, it } from "vitest";

describe("vllm plugin entry", () => {
  it("loads without recursive plugin-sdk imports", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toMatchObject({ id: "vllm" });
  });
});
