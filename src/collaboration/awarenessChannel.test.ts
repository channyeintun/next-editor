import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { IMPLICIT_AWARENESS_INTERVAL_MS, RoomAwarenessChannel } from "./awarenessChannel";
import {
  decodeCollaborationAwarenessProtocolUpdate,
  decodeCollaborationBinaryFrame,
  encodeCollaborationAwarenessProtocolUpdate,
} from "./binaryProtocol";
import type { CollaborationAwarenessEvent } from "./protocol";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "30000000-0000-4000-8000-000000000001";
const SESSION_ID = "50000000-0000-4000-8000-000000000001";
const POSITION = { type: null, tname: "source", item: null, assoc: 0 };

function selection(assoc: number) {
  return { anchor: POSITION, head: { ...POSITION, assoc } };
}

function editorState(revision: number) {
  return {
    kind: "state" as const,
    sessionId: SESSION_ID,
    revision,
    surface: { kind: "editor" as const, fileNodeId: null, viewport: null },
    cursor: null,
  };
}

function createChannel() {
  let now = 1_000;
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const send = vi.fn<(data: ArrayBufferView<ArrayBuffer>) => void>();
  const onSendFailure = vi.fn<() => void>();
  const onEvent = vi.fn<(event: CollaborationAwarenessEvent) => void>();
  const live = { current: true };
  const channel = new RoomAwarenessChannel({
    awareness,
    isLive: () => live.current,
    openSocket: () => ({ send }),
    onSendFailure,
    onEvent,
    now: () => now,
  });
  /** The local states the channel sent, in order. */
  const sentStates = () =>
    send.mock.calls.map(([raw]) => {
      const frame = decodeCollaborationBinaryFrame(
        new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
      );
      if (frame.kind !== "awareness") throw new Error("not an awareness frame");
      return decodeCollaborationAwarenessProtocolUpdate(frame.update)[0]?.state as Record<
        string,
        unknown
      > | null;
    });
  return {
    awareness,
    channel,
    send,
    sentStates,
    onSendFailure,
    onEvent,
    live,
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
    destroy: () => {
      channel.dispose();
      awareness.destroy();
      doc.destroy();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RoomAwarenessChannel", () => {
  it("coalesces implicit changes within the interval into one later send", () => {
    const room = createChannel();
    room.channel.publish(editorState(1));
    expect(room.send).toHaveBeenCalledTimes(1);

    room.advance(50);
    room.awareness.setLocalStateField("selection", selection(1));
    room.awareness.setLocalStateField("selection", selection(-1));
    expect(room.send).toHaveBeenCalledTimes(1);

    room.advance(IMPLICIT_AWARENESS_INTERVAL_MS - 50);

    expect(room.send).toHaveBeenCalledTimes(2);
    expect(room.sentStates()[1]).toEqual(expect.objectContaining({ selection: selection(-1) }));
    room.destroy();
  });

  it("sends an implicit change at once when the interval has already passed", () => {
    const room = createChannel();
    room.channel.publish(editorState(1));

    room.advance(IMPLICIT_AWARENESS_INTERVAL_MS);
    room.awareness.setLocalStateField("selection", selection(1));

    expect(room.send).toHaveBeenCalledTimes(2);
    room.destroy();
  });

  it("lets an explicit publish or a leave replace a throttled change", () => {
    const room = createChannel();
    room.channel.publish(editorState(1));
    room.awareness.setLocalStateField("selection", selection(1));

    room.channel.publish(editorState(2));
    expect(room.send).toHaveBeenCalledTimes(2);
    room.advance(IMPLICIT_AWARENESS_INTERVAL_MS);
    expect(room.send).toHaveBeenCalledTimes(2);

    room.channel.publish(editorState(3));
    room.awareness.setLocalStateField("selection", selection(-1));
    room.channel.publish({ kind: "leave", sessionId: SESSION_ID, revision: 4 });
    room.advance(IMPLICIT_AWARENESS_INTERVAL_MS);

    expect(room.sentStates()).toHaveLength(4);
    expect(room.sentStates()[3]).toBeNull();
    room.destroy();
  });

  it("drops changes made while suppressed but flushes the state queued before", () => {
    const room = createChannel();
    room.channel.publish(editorState(1));
    room.awareness.setLocalStateField("selection", selection(1));

    room.channel.setSuppressed(true);
    room.awareness.setLocalStateField("selection", selection(-1));
    room.advance(IMPLICIT_AWARENESS_INTERVAL_MS);

    expect(room.sentStates()).toHaveLength(2);
    expect(room.sentStates()[1]).toEqual(expect.objectContaining({ selection: selection(1) }));
    room.destroy();
  });

  it("publishes no editor selection while suppressed", () => {
    const room = createChannel();
    room.channel.publish(editorState(1));
    room.awareness.setLocalStateField("selection", selection(1));
    room.advance(IMPLICIT_AWARENESS_INTERVAL_MS);

    room.channel.setSuppressed(true);
    room.channel.publish(editorState(2));

    expect(room.sentStates().at(-1)).toEqual(expect.objectContaining({ selection: null }));
    room.destroy();
  });

  it("sends nothing while the room is not live and reports a failed send", () => {
    const room = createChannel();
    room.live.current = false;
    room.channel.publish(editorState(1));
    expect(room.send).not.toHaveBeenCalled();

    room.live.current = true;
    room.send.mockImplementation(() => {
      throw new Error("socket closed");
    });
    room.channel.publish(editorState(2));

    expect(room.onSendFailure).toHaveBeenCalledTimes(1);
    room.destroy();
  });

  it("turns remote states and their removal into participant events", () => {
    const room = createChannel();
    const remote = {
      kind: "state" as const,
      roomId: ROOM_ID,
      actorId: ACTOR_ID,
      sessionId: "60000000-0000-4000-8000-000000000001",
      revision: 4,
      role: "owner" as const,
      username: "host",
      name: null,
      avatarUrl: null,
      isHost: true,
      surface: { kind: "editor" as const, fileNodeId: null, viewport: null },
      cursor: null,
      occurredAt: 1,
      expiresAt: 2,
    };

    room.channel.applyRemote(
      encodeCollaborationAwarenessProtocolUpdate([
        { clientId: 42, clock: 1, state: { collaboration: remote } },
      ]),
    );
    room.channel.applyRemote(
      encodeCollaborationAwarenessProtocolUpdate([{ clientId: 42, clock: 2, state: null }]),
    );

    expect(room.onEvent.mock.calls.map(([event]) => event)).toEqual([
      remote,
      {
        kind: "leave",
        roomId: ROOM_ID,
        actorId: ACTOR_ID,
        sessionId: remote.sessionId,
        revision: 5,
        occurredAt: expect.any(Number),
      },
    ]);
    // A remote update is never echoed back to the room.
    expect(room.send).not.toHaveBeenCalled();
    room.destroy();
  });
});
