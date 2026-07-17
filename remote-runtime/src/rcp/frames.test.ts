import { describe, expect, it } from "vitest";
import { RcpError } from "./errors";
import {
  encodeBinaryFrame,
  encodeControlFrame,
  parseBinaryFrame,
  parseControlFrame,
} from "./frames";

describe("RCP frames", () => {
  it("round-trips control frames", () => {
    const frame = { t: "req", id: 7, m: "session.ping", p: {} } as const;
    expect(parseControlFrame(encodeControlFrame(frame))).toEqual(frame);
  });

  it("rejects unknown control frame types", () => {
    expect(() => parseControlFrame('{"t":"wat"}')).toThrowError(RcpError);
  });

  it("round-trips binary frames and FIN", () => {
    const parsed = parseBinaryFrame(encodeBinaryFrame(9, new Uint8Array([1, 2]), true));
    expect(parsed).toEqual({ channelId: 9, fin: true, payload: new Uint8Array([1, 2]) });
  });

  it("rejects channel zero", () => {
    expect(() => parseBinaryFrame(new Uint8Array(5))).toThrow("EPROTO:");
  });
});
