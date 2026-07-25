import * as awarenessProtocol from "y-protocols/awareness";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { resolveMonacoAwarenessSelections } from "./monacoAwareness";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";

describe("y-monaco awareness", () => {
  it("resolves a remote relative selection against the matching shared text", () => {
    const remoteDoc = new Y.Doc();
    const remoteText = new Y.Text("hello");
    remoteDoc.getMap<Y.Text>("texts").set("file", remoteText);
    const localDoc = new Y.Doc();
    Y.applyUpdate(localDoc, Y.encodeStateAsUpdate(remoteDoc));
    const localText = localDoc.getMap<Y.Text>("texts").get("file");
    if (!localText) throw new Error("shared text was not synchronized");

    const remote = new awarenessProtocol.Awareness(remoteDoc);
    const local = new awarenessProtocol.Awareness(localDoc);
    remote.setLocalState({
      collaboration: {
        kind: "state",
        roomId: ROOM_ID,
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
        revision: 1,
        role: "editor",
        username: "ada",
        name: "Ada",
        avatarUrl: null,
        isHost: false,
        surface: { kind: "editor", fileNodeId: null, viewport: null },
        cursor: null,
        occurredAt: 1,
        expiresAt: Date.now() + 45_000,
      },
      selection: {
        anchor: Y.createRelativePositionFromTypeIndex(remoteText, 1),
        head: Y.createRelativePositionFromTypeIndex(remoteText, 4),
      },
    });
    awarenessProtocol.applyAwarenessUpdate(
      local,
      awarenessProtocol.encodeAwarenessUpdate(remote, [remote.clientID]),
      "remote",
    );

    expect(resolveMonacoAwarenessSelections(local, localText)).toEqual([
      expect.objectContaining({
        clientId: remote.clientID,
        anchorOffset: 1,
        headOffset: 4,
        participant: expect.objectContaining({ actorId: ACTOR_ID, sessionId: SESSION_ID }),
      }),
    ]);

    remote.destroy();
    local.destroy();
    remoteDoc.destroy();
    localDoc.destroy();
  });

  it("drops a selection that names a root type instead of carrying an item", () => {
    // A relative position with no item resolves through Y.Doc.get(tname), which
    // permanently creates that root type — so a peer cycling `tname` could grow
    // the victim's doc.share without bound. The schema allows any string there.
    const localDoc = new Y.Doc();
    const localText = localDoc.getMap<Y.Text>("texts").set("file", new Y.Text("hello"));
    const local = new awarenessProtocol.Awareness(localDoc);

    const rootsBefore = localDoc.share.size;
    local.setLocalState(null);
    local.states.set(999, {
      collaboration: {
        kind: "state",
        roomId: ROOM_ID,
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
        revision: 1,
        role: "editor",
        username: "mallory",
        name: "Mallory",
        avatarUrl: null,
        isHost: false,
        surface: { kind: "editor", fileNodeId: null, viewport: null },
        cursor: null,
        occurredAt: 1,
        expiresAt: Date.now() + 45_000,
      },
      selection: {
        anchor: { type: null, tname: "injected-root-a", item: null, assoc: 0 },
        head: { type: null, tname: "injected-root-b", item: null, assoc: 0 },
      },
    });

    expect(resolveMonacoAwarenessSelections(local, localText)).toEqual([]);
    expect(localDoc.share.size).toBe(rootsBefore);
    expect(localDoc.share.has("injected-root-a")).toBe(false);

    local.destroy();
    localDoc.destroy();
  });
});
