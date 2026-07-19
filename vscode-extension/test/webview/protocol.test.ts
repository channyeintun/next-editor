import { describe, expect, it } from "vitest";
import {
  parseHostMessage,
  parseWebviewMessage,
  PROTOCOL_VERSION,
} from "../../src/webview/bridge/protocol";

describe("webview protocol", () => {
  it("exposes a protocol version", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("accepts valid host messages", () => {
    expect(parseHostMessage({ type: "host.hello", protocolVersion: 2 })).not.toBeNull();
    expect(parseHostMessage({ type: "player.pause" })).not.toBeNull();
    expect(
      parseHostMessage({
        type: "recording.eventWindow",
        requestId: "r1",
        fromSeq: 0,
        events: [{ seq: 0, tUs: 0, type: "marker", payload: { label: "x" } }],
        done: true,
      }),
    ).not.toBeNull();
    expect(
      parseHostMessage({
        type: "recording.checkpoint",
        requestId: "r2",
        documentId: "d",
        checkpointId: "c",
        text: "body",
      }),
    ).not.toBeNull();
    expect(
      parseHostMessage({
        type: "request.failed",
        requestId: "r3",
        message: "nope",
      }),
    ).not.toBeNull();
  });

  it("rejects malformed or unknown host messages", () => {
    expect(parseHostMessage(null)).toBeNull();
    expect(parseHostMessage({ type: "totally.unknown" })).toBeNull();
    expect(
      parseHostMessage({
        type: "recording.eventWindow",
        requestId: "r1",
        fromSeq: -1,
        events: [],
        done: false,
      }),
    ).toBeNull();
    expect(
      parseHostMessage({
        type: "recording.eventWindow",
        requestId: "r1",
        fromSeq: 0,
        events: [{ seq: 0, type: "malformed-event" }],
        done: false,
      }),
    ).toBeNull();
  });

  it("accepts valid webview messages and rejects abusive ones", () => {
    expect(parseWebviewMessage({ type: "webview.ready", protocolVersion: 2 })).not.toBeNull();
    expect(
      parseWebviewMessage({
        type: "recording.requestWindow",
        requestId: "r1",
        fromSeq: 0,
        maxCount: 20_000,
      }),
    ).not.toBeNull();
    // Window size abuse is rejected at the schema boundary.
    expect(
      parseWebviewMessage({
        type: "recording.requestWindow",
        requestId: "r1",
        fromSeq: 0,
        maxCount: 10_000_000,
      }),
    ).toBeNull();
    // Oversized error strings are rejected rather than truncated.
    expect(parseWebviewMessage({ type: "webview.error", message: "x".repeat(5000) })).toBeNull();
    expect(parseWebviewMessage({ type: "player.stateChanged" })).toBeNull();
  });
});
