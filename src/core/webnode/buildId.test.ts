// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BUILD_ID, versionedPath } from "./buildId";

describe("versionedPath", () => {
  it("names the build a script asks for", () => {
    expect(versionedPath("/__webnode__/process.js", "m3k9x1")).toBe(
      "/__webnode__/process.js?v=m3k9x1",
    );
    expect(versionedPath("/__webnode__/kernel.js", "a b")).toBe("/__webnode__/kernel.js?v=a%20b");
  });

  it("leaves the path alone where the build gives no id, as in these tests", () => {
    expect(BUILD_ID).toBe("");
    expect(versionedPath("/__webnode__/process.js")).toBe("/__webnode__/process.js");
  });
});
