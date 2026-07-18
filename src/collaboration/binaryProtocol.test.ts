import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CollaborationBinaryProtocolError,
  decodeCollaborationAwarenessProtocolUpdate,
  decodeCollaborationBinaryFrame,
  encodeCollaborationAwarenessProtocolUpdate,
  encodeCollaborationAwarenessUpdate,
  encodeCollaborationClientUpdate,
  encodeCollaborationServerUpdate,
  encodeCollaborationSyncStep1,
  encodeCollaborationSyncStep2,
} from "./binaryProtocol";
import { collaborationAwarenessClientStateSchema } from "./protocol";

const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const UPDATE_ID = "20000000-0000-4000-8000-000000000002";

describe("collaboration binary protocol", () => {
  it("negotiates missing Yjs state with standard sync step messages", () => {
    const client = new Y.Doc();
    client.getText("content").insert(0, "client");
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client));
    server.getText("content").insert(6, "-server");

    const step1 = decodeCollaborationBinaryFrame(encodeCollaborationSyncStep1(client));
    expect(step1).toMatchObject({
      kind: "sync",
      messageType: syncProtocol.messageYjsSyncStep1,
    });
    if (step1.kind !== "sync") throw new Error("expected sync step 1");

    const step2 = decodeCollaborationBinaryFrame(
      encodeCollaborationSyncStep2(server, step1.payload),
    );
    expect(step2).toMatchObject({
      kind: "sync",
      messageType: syncProtocol.messageYjsSyncStep2,
    });
    if (step2.kind !== "sync") throw new Error("expected sync step 2");
    Y.applyUpdate(client, step2.payload);
    expect(client.getText("content").toString()).toBe("client-server");

    client.destroy();
    server.destroy();
  });

  it("round-trips client and server update metadata without base64", () => {
    const source = new Y.Doc();
    source.getText("content").insert(0, "x".repeat(64 * 1024));
    const update = Y.encodeStateAsUpdate(source);

    expect(
      decodeCollaborationBinaryFrame(
        encodeCollaborationClientUpdate({ clientId: CLIENT_ID, updateId: UPDATE_ID, update }),
      ),
    ).toEqual({ kind: "client-update", clientId: CLIENT_ID, updateId: UPDATE_ID, update });
    expect(
      decodeCollaborationBinaryFrame(
        encodeCollaborationServerUpdate({ streamId: "42-0", updateId: UPDATE_ID, update }),
      ),
    ).toEqual({ kind: "server-update", streamId: "42-0", updateId: UPDATE_ID, update });

    const base64Length = 4 * Math.ceil(update.byteLength / 3);
    expect(update.byteLength).toBeLessThanOrEqual(base64Length * 0.75);
    source.destroy();
  });

  it("wraps standard awareness updates", () => {
    const sourceDoc = new Y.Doc();
    const targetDoc = new Y.Doc();
    const source = new awarenessProtocol.Awareness(sourceDoc);
    const target = new awarenessProtocol.Awareness(targetDoc);
    source.setLocalStateField("name", "Ada");
    const encoded = awarenessProtocol.encodeAwarenessUpdate(source, [source.clientID]);
    expect(decodeCollaborationAwarenessProtocolUpdate(encoded)).toEqual([
      { clientId: source.clientID, clock: 1, state: { name: "Ada" } },
    ]);
    const reencoded = encodeCollaborationAwarenessProtocolUpdate(
      decodeCollaborationAwarenessProtocolUpdate(encoded),
    );
    const frame = decodeCollaborationBinaryFrame(encodeCollaborationAwarenessUpdate(reencoded));
    expect(frame).toEqual({ kind: "awareness", update: reencoded });
    if (frame.kind !== "awareness") throw new Error("expected awareness frame");
    awarenessProtocol.applyAwarenessUpdate(target, frame.update, "test");
    expect(target.getStates().get(source.clientID)).toEqual({ name: "Ada" });
    source.destroy();
    target.destroy();
    sourceDoc.destroy();
    targetDoc.destroy();
  });

  it("keeps the largest valid client view state below the 16 KiB awareness limit", () => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(
      collaborationAwarenessClientStateSchema.parse({
        collaboration: {
          kind: "state",
          sessionId: CLIENT_ID,
          revision: Number.MAX_SAFE_INTEGER,
          surface: {
            kind: "editor",
            fileNodeId: UPDATE_ID,
            viewport: {
              topAnchor: "A".repeat(2_048),
              topDeltaPx: 4_096,
              scrollLeftPx: 1_000_000,
            },
          },
          cursor: {
            fileNodeId: UPDATE_ID,
            anchor: "A".repeat(2_048),
            head: "A".repeat(2_048),
          },
        },
        selection: null,
      }),
    );
    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]);
    const frame = encodeCollaborationAwarenessUpdate(update);

    expect(frame.byteLength).toBeLessThan(16 * 1024);
    awareness.destroy();
    doc.destroy();
  });

  it("rejects unknown versions and trailing bytes", () => {
    expect(() => decodeCollaborationBinaryFrame(Uint8Array.of(2, 0))).toThrow(
      CollaborationBinaryProtocolError,
    );
    const valid = encodeCollaborationClientUpdate({
      clientId: CLIENT_ID,
      updateId: UPDATE_ID,
      update: Uint8Array.of(1, 2, 3),
    });
    const trailing = new Uint8Array(valid.byteLength + 1);
    trailing.set(valid);
    expect(() => decodeCollaborationBinaryFrame(trailing)).toThrow(
      CollaborationBinaryProtocolError,
    );
    // Frame type 4 is intentionally unassigned: live slide interactions have no
    // binary transport in protocol v3.
    expect(() => decodeCollaborationBinaryFrame(Uint8Array.of(3, 4))).toThrow(
      CollaborationBinaryProtocolError,
    );
  });
});
