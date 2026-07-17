import { describe, expect, it } from "vitest";
import { recordingOpfsFilename } from "./recordingOpfsShared";

describe("recordingOpfsFilename", () => {
  it("maps recording ids to one traversal-safe OPFS filename", () => {
    const filename = recordingOpfsFilename("../../lesson / 1");

    expect(filename).toBe("..%2F..%2Flesson%20%2F%201.scr3");
    expect(filename).not.toContain("/");
  });
});
