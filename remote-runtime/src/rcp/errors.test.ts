import { describe, expect, it } from "vitest";
import { RcpError, fromWireError, isFatalRcpError } from "./errors";

describe("RCP errors", () => {
  it("prefixes errno messages", () => {
    expect(fromWireError({ code: "ENOENT", message: "no such file" }).message)
      .toBe("ENOENT: no such file");
  });

  it("classifies protocol and gone errors as fatal", () => {
    expect(isFatalRcpError(new RcpError("EPROTO", "bad frame"))).toBe(true);
    expect(isFatalRcpError(new RcpError("EGONE", "gone"))).toBe(true);
    expect(isFatalRcpError(new RcpError("EACCES", "denied"))).toBe(false);
  });
});
