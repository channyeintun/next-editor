import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  MAX_COLLABORATION_EDITOR_SCROLL_LEFT_PX,
  MAX_COLLABORATION_EDITOR_TOP_DELTA_PX,
  MAX_COLLABORATION_WHITEBOARD_COORDINATE,
  MAX_COLLABORATION_WHITEBOARD_ZOOM,
  MAX_ENCODED_YJS_UPDATE_LENGTH,
  canPublishCollaborationUpdate,
  collaborationDocumentUpdateInputSchema,
  collaborationCreateRoomInputSchema,
  collaborationAwarenessClientStateSchema,
  collaborationAwarenessInputSchema,
  collaborationCurrentSlideCommandSchema,
  collaborationSurfaceSchema,
  collaborationWebSocketServerMessageSchema,
} from "./protocol";
import {
  applyEncodedYjsUpdate,
  createCollaborationRoomSnapshot,
  createCollaborationDocumentUpdate,
  decodeYjsUpdate,
  encodeYjsUpdate,
} from "./yjsUpdates";

const ROOM_ID = "8c1dfdbf-4605-4c3b-bf45-b4634f0eabe2";
const CLIENT_ID = "62e42510-e038-4e25-9a95-5f62ae0f29a6";

describe("collaboration protocol", () => {
  it("round-trips a Yjs update and remains idempotent when delivered twice", () => {
    const source = new Y.Doc();
    source.getText("content").insert(0, "shared text");

    const encoded = encodeYjsUpdate(Y.encodeStateAsUpdate(source));
    expect(decodeYjsUpdate(encoded)).toEqual(Y.encodeStateAsUpdate(source));

    const target = new Y.Doc();
    applyEncodedYjsUpdate(target, encoded);
    applyEncodedYjsUpdate(target, encoded);

    expect(target.getText("content").toString()).toBe("shared text");
  });

  it("creates a versioned, validated document update envelope", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "hello");

    const input = createCollaborationDocumentUpdate(Y.encodeStateAsUpdate(doc), CLIENT_ID);

    expect(input.protocolVersion).toBe(COLLABORATION_PROTOCOL_VERSION);
    expect(input.documentSchemaVersion).toBe(COLLABORATION_DOCUMENT_SCHEMA_VERSION);
    expect(input.clientId).toBe(CLIENT_ID);
    expect(input.updateId).toMatch(/^[0-9a-f-]{36}$/);
    expect(collaborationDocumentUpdateInputSchema.safeParse(input).success).toBe(true);
  });

  it("rejects malformed, oversized, and version-mismatched updates", () => {
    const base = {
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
      clientId: CLIENT_ID,
      updateId: ROOM_ID,
      update: "AAA=",
    };

    expect(
      collaborationDocumentUpdateInputSchema.safeParse({ ...base, update: "not-base64" }).success,
    ).toBe(false);
    expect(
      collaborationDocumentUpdateInputSchema.safeParse({
        ...base,
        update: "A".repeat(MAX_ENCODED_YJS_UPDATE_LENGTH + 4),
      }).success,
    ).toBe(false);
    expect(
      collaborationDocumentUpdateInputSchema.safeParse({ ...base, protocolVersion: 1 }).success,
    ).toBe(false);
  });

  it("allows bounded room snapshots larger than an individual live update", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "x".repeat(80 * 1024));

    const snapshot = createCollaborationRoomSnapshot(doc, CLIENT_ID);
    expect(collaborationCreateRoomInputSchema.safeParse(snapshot).success).toBe(true);
    expect(
      collaborationDocumentUpdateInputSchema.safeParse({
        ...snapshot,
        update: snapshot.snapshot,
        snapshot: undefined,
      }).success,
    ).toBe(false);
  });

  it("applies write roles", () => {
    expect(canPublishCollaborationUpdate("owner")).toBe(true);
    expect(canPublishCollaborationUpdate("editor")).toBe(true);
    expect(canPublishCollaborationUpdate("viewer")).toBe(false);
  });

  it("strictly separates editor, slide, and whiteboard awareness", () => {
    expect(
      collaborationAwarenessInputSchema.safeParse({
        kind: "state",
        sessionId: CLIENT_ID,
        revision: 1,
        surface: {
          kind: "editor",
          fileNodeId: ROOM_ID,
          viewport: { topAnchor: "AAAA", topDeltaPx: 4, scrollLeftPx: 120 },
        },
        cursor: { fileNodeId: ROOM_ID, anchor: "AAAA", head: "AAAA" },
      }).success,
    ).toBe(true);
    expect(
      collaborationAwarenessInputSchema.safeParse({
        kind: "state",
        sessionId: CLIENT_ID,
        revision: 1,
        surface: { kind: "slides", isMaximized: true },
        cursor: null,
      }).success,
    ).toBe(true);
    expect(
      collaborationSurfaceSchema.safeParse({
        kind: "whiteboard",
        isMaximized: true,
        viewport: { scrollX: 12, scrollY: -4, zoom: 1.5 },
      }).success,
    ).toBe(true);
    expect(
      collaborationAwarenessInputSchema.safeParse({
        kind: "state",
        sessionId: CLIENT_ID,
        revision: 1,
        surface: { kind: "slides", isMaximized: true, slideId: "secret" },
        cursor: null,
      }).success,
    ).toBe(false);
    expect(
      collaborationAwarenessClientStateSchema.safeParse({
        collaboration: {
          kind: "state",
          sessionId: CLIENT_ID,
          revision: 2,
          surface: { kind: "slides", isMaximized: true },
          cursor: null,
        },
        selection: {
          anchor: { type: null, tname: "source", item: null, assoc: 0 },
          head: { type: null, tname: "source", item: null, assoc: 0 },
        },
      }).success,
    ).toBe(false);
    expect(
      collaborationAwarenessInputSchema.safeParse({
        kind: "state",
        sessionId: CLIENT_ID,
        revision: 2,
        surface: { kind: "slides", isMaximized: false },
        cursor: {
          fileNodeId: ROOM_ID,
          anchor: "AAAA",
          head: "AAAA",
        },
      }).success,
    ).toBe(false);
    expect(
      collaborationAwarenessInputSchema.safeParse({
        kind: "state",
        sessionId: CLIENT_ID,
        revision: 1,
        surface: {
          kind: "whiteboard",
          isMaximized: false,
          viewport: { scrollX: 0, scrollY: 0, zoom: Number.NaN },
        },
        cursor: null,
        followingHost: true,
      }).success,
    ).toBe(false);
    expect(
      collaborationAwarenessInputSchema.safeParse({
        kind: "leave",
        sessionId: CLIENT_ID,
        revision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });

  it("rejects every out-of-bounds or mixed-surface awareness field", () => {
    const invalidSurfaces = [
      { kind: "editor", fileNodeId: "not-a-uuid", viewport: null },
      {
        kind: "editor",
        fileNodeId: ROOM_ID,
        viewport: { topAnchor: "not-base64", topDeltaPx: 0, scrollLeftPx: 0 },
      },
      {
        kind: "editor",
        fileNodeId: ROOM_ID,
        viewport: { topAnchor: "A".repeat(2_052), topDeltaPx: 0, scrollLeftPx: 0 },
      },
      {
        kind: "editor",
        fileNodeId: ROOM_ID,
        viewport: {
          topAnchor: "AAAA",
          topDeltaPx: MAX_COLLABORATION_EDITOR_TOP_DELTA_PX + 1,
          scrollLeftPx: 0,
        },
      },
      {
        kind: "editor",
        fileNodeId: ROOM_ID,
        viewport: {
          topAnchor: "AAAA",
          topDeltaPx: 0,
          scrollLeftPx: MAX_COLLABORATION_EDITOR_SCROLL_LEFT_PX + 1,
        },
      },
      { kind: "slides", isMaximized: true, indexv: 1 },
      {
        kind: "whiteboard",
        isMaximized: false,
        viewport: {
          scrollX: MAX_COLLABORATION_WHITEBOARD_COORDINATE + 1,
          scrollY: 0,
          zoom: 1,
        },
      },
      {
        kind: "whiteboard",
        isMaximized: false,
        viewport: { scrollX: 0, scrollY: 0, zoom: 0 },
      },
      {
        kind: "whiteboard",
        isMaximized: false,
        viewport: { scrollX: 0, scrollY: 0, zoom: MAX_COLLABORATION_WHITEBOARD_ZOOM + 1 },
      },
      {
        kind: "whiteboard",
        isMaximized: false,
        viewport: { scrollX: 0, scrollY: 0, zoom: Number.NaN },
      },
      {
        kind: "whiteboard",
        isMaximized: false,
        viewport: { scrollX: 0, scrollY: Number.POSITIVE_INFINITY, zoom: 1 },
      },
      {
        kind: "whiteboard",
        isMaximized: false,
        fileNodeId: ROOM_ID,
        viewport: { scrollX: 0, scrollY: 0, zoom: 1 },
      },
    ];

    for (const surface of invalidSurfaces) {
      expect(collaborationSurfaceSchema.safeParse(surface).success).toBe(false);
    }
  });

  it("accepts only a bounded whole-slide command", () => {
    expect(collaborationCurrentSlideCommandSchema.safeParse({ slideId: "slide-1" }).success).toBe(
      true,
    );
    expect(
      collaborationCurrentSlideCommandSchema.safeParse({ slideId: "slide-1", indexv: 2 }).success,
    ).toBe(false);
    expect(
      collaborationCurrentSlideCommandSchema.safeParse({ slideId: "slide-1", content: "hidden" })
        .success,
    ).toBe(false);
    expect(
      collaborationCurrentSlideCommandSchema.safeParse({
        slideId: "slide-1",
        interaction: { type: "click" },
      }).success,
    ).toBe(false);
    expect(collaborationCurrentSlideCommandSchema.safeParse({ slideId: "bad id" }).success).toBe(
      false,
    );
    expect(
      collaborationCurrentSlideCommandSchema.safeParse({ slideId: "x".repeat(257) }).success,
    ).toBe(false);
  });

  it("validates the binary transport's JSON control envelopes", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "hello");
    const update = createCollaborationDocumentUpdate(Y.encodeStateAsUpdate(doc), CLIENT_ID);

    expect(
      collaborationWebSocketServerMessageSchema.safeParse({
        type: "document.ack",
        updateId: update.updateId,
        streamId: "1-0",
        duplicate: false,
      }).success,
    ).toBe(true);
    expect(
      collaborationWebSocketServerMessageSchema.safeParse({
        type: "document.ack",
        updateId: update.updateId,
        streamId: "not-a-stream-id",
        duplicate: false,
      }).success,
    ).toBe(false);
    expect(
      collaborationWebSocketServerMessageSchema.safeParse({
        type: "document.update",
        streamId: "1-0",
        data: update,
      }).success,
    ).toBe(false);
  });
});
