import { describe, expect, it } from "vitest";

describe("sglang plugin entry", () => {
  it("loads without recursive plugin-sdk imports", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toMatchObject({ id: "sglang" });
  });
});
