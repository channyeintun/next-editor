import { describe, expect, it } from "vite-plus/test";
import { isNotFoundError, recordingOpfsFilename } from "./recordingOpfsShared";

describe("recordingOpfsFilename", () => {
  it("maps recording ids to one traversal-safe OPFS filename", () => {
    const filename = recordingOpfsFilename("../../lesson / 1");

    expect(filename).toBe("..%2F..%2Flesson%20%2F%201.scr3");
    expect(filename).not.toContain("/");
  });
});

describe("isNotFoundError", () => {
  it("recognizes only the DOMException a missing entry rejects with", () => {
    expect(isNotFoundError(new DOMException("missing", "NotFoundError"))).toBe(true);
    expect(isNotFoundError(new DOMException("denied", "NotAllowedError"))).toBe(false);
    expect(isNotFoundError(Object.assign(new Error("missing"), { name: "NotFoundError" }))).toBe(
      false,
    );
    expect(isNotFoundError(undefined)).toBe(false);
  });
});
