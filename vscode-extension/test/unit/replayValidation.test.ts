import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/capture/hash";
import type { SessionEvent } from "../../src/model/events";
import { validateSessionReplay } from "../../src/storage/replayValidation";

// Hand-built journal with real hashes, exercising the full validation path.
function buildSession() {
  const initial = "line one\nline two\n";
  const afterPatch = "line ONE\nline two\n";
  const checkpoints = new Map<string, string>([["cp-0", initial]]);
  const events: SessionEvent[] = [
    {
      seq: 0,
      tUs: 0,
      type: "session.started",
      payload: {
        sessionId: "s",
        extensionVersion: "0",
        vscodeVersion: "0",
        platform: "test",
        architecture: "test",
      },
    } as SessionEvent,
    {
      seq: 1,
      tUs: 10,
      type: "document.enrolled",
      payload: {
        descriptor: {
          documentId: "doc-1",
          rootId: null,
          logicalPath: "a.txt",
          displayName: "a.txt",
          schemeClass: "file",
          languageId: "plaintext",
          eol: "LF",
          initialVersion: 1,
          initialCheckpointId: "cp-0",
          byteLength: Buffer.byteLength(initial),
          sha256: sha256Hex(initial),
        },
      },
    } as SessionEvent,
    {
      seq: 2,
      tUs: 20,
      type: "surface.opened",
      payload: {
        surfaceId: "surf-1",
        documentId: "doc-1",
        groupId: null,
        viewColumn: 1,
        selections: [],
        visibleRanges: [],
        isActive: true,
      },
    } as SessionEvent,
    {
      seq: 3,
      tUs: 30,
      type: "document.patch",
      payload: {
        documentId: "doc-1",
        beforeVersion: 1,
        afterVersion: 2,
        reason: "unknown",
        changes: [{ rangeOffsetUtf16: 5, rangeLengthUtf16: 3, text: "ONE" }],
        beforeHash: sha256Hex(initial),
        afterHash: sha256Hex(afterPatch),
        eolBefore: "LF",
        eolAfter: "LF",
      },
    } as SessionEvent,
  ];
  return { events, checkpoints, afterPatch };
}

describe("validateSessionReplay", () => {
  it("accepts a consistent session and reproduces final text", () => {
    const { events, checkpoints, afterPatch } = buildSession();
    const result = validateSessionReplay(events, (id) => checkpoints.get(id));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.finalDocuments.get("doc-1")?.text).toBe(afterPatch);
  });

  it("rejects a tampered afterHash", () => {
    const { events, checkpoints } = buildSession();
    const patch = events[3] as Extract<SessionEvent, { type: "document.patch" }>;
    patch.payload.afterHash = sha256Hex("bogus");
    const result = validateSessionReplay(events, (id) => checkpoints.get(id));
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("afterHash mismatch");
  });

  it("rejects a missing checkpoint body", () => {
    const { events } = buildSession();
    const result = validateSessionReplay(events, () => undefined);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("missing initial checkpoint");
  });

  it("rejects out-of-bounds changes", () => {
    const { events, checkpoints } = buildSession();
    const patch = events[3] as Extract<SessionEvent, { type: "document.patch" }>;
    patch.payload.changes = [{ rangeOffsetUtf16: 10_000, rangeLengthUtf16: 5, text: "x" }];
    const result = validateSessionReplay(events, (id) => checkpoints.get(id));
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("out of bounds");
  });

  it("rejects surface events for unknown surfaces", () => {
    const { events, checkpoints } = buildSession();
    events.push({
      seq: 4,
      tUs: 40,
      type: "surface.focused",
      payload: { surfaceId: "ghost" },
    } as SessionEvent);
    const result = validateSessionReplay(events, (id) => checkpoints.get(id));
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("unknown surface");
  });

  it("rejects sequence gaps", () => {
    const { events, checkpoints } = buildSession();
    events.push({
      seq: 99,
      tUs: 50,
      type: "marker",
      payload: { label: "gap" },
    } as SessionEvent);
    const result = validateSessionReplay(events, (id) => checkpoints.get(id));
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("sequence gap");
  });
});
