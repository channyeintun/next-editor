import * as awarenessProtocol from "y-protocols/awareness";
import { encodeCollaborationAwarenessUpdate } from "./binaryProtocol";
import {
  collaborationAwarenessClientStateSchema,
  collaborationAwarenessServerStateSchema,
  type CollaborationAwarenessEvent,
  type CollaborationAwarenessInput,
} from "./protocol";
import { COLLABORATION_ORIGIN } from "./projectDocument";

// y-monaco republishes the local selection on every Monaco selection change,
// each mousemove of a drag-select, and the room accepts 20 awareness frames
// per second per socket, refusing the rest without broadcasting them (the
// final selection among them). Explicit publishes are already throttled by
// the collaboration context and carry the current selection, so they go out
// at once; any other change waits until this long after the last frame of
// either kind, which keeps the total near 13 per second.
export const IMPLICIT_AWARENESS_INTERVAL_MS = 150;

export interface RoomAwarenessChannelOptions {
  awareness: awarenessProtocol.Awareness;
  /** Whether the room connection is live; local changes are published only then. */
  isLive: () => boolean;
  /** The socket to send a frame on, or null while none is open. */
  openSocket: () => { send(data: ArrayBufferView<ArrayBuffer>): void } | null;
  /** A frame could not be sent on the open socket. */
  onSendFailure: () => void;
  /** A remote participant's awareness, or its departure. */
  onEvent?: (event: CollaborationAwarenessEvent) => void;
  /** A monotonic clock in milliseconds, for the implicit-update throttle. */
  now: () => number;
}

/**
 * The room's awareness traffic over one provider's socket: explicit
 * publishes go out at once, implicit local changes (y-monaco's selection) are
 * throttled to the room's rate and held back while publication is suppressed,
 * and remote states become participant events.
 */
export class RoomAwarenessChannel {
  private readonly options: RoomAwarenessChannelOptions;
  private readonly remoteAwarenessEvents = new Map<number, CollaborationAwarenessEvent>();
  private awarenessPublicationSuppressed = false;
  private isPublishingExplicitAwareness = false;
  private lastAwarenessSentAt = Number.NEGATIVE_INFINITY;
  private pendingAwarenessUpdate: Uint8Array | null = null;
  private pendingAwarenessTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RoomAwarenessChannelOptions) {
    this.options = options;
    options.awareness.on("update", this.handleProtocolUpdate);
    options.awareness.on("change", this.handleProtocolChange);
  }

  /** Publishes this member's awareness, or its departure, right away. */
  publish(input: CollaborationAwarenessInput): void {
    const { awareness } = this.options;
    this.isPublishingExplicitAwareness = true;
    try {
      if (input.kind === "leave") {
        awareness.setLocalState(null);
      } else {
        const selection =
          input.surface.kind === "editor" && !this.awarenessPublicationSuppressed
            ? awareness.getLocalState()?.selection
            : null;
        awareness.setLocalState(
          collaborationAwarenessClientStateSchema.parse({
            collaboration: input,
            ...(selection === undefined ? {} : { selection }),
          }),
        );
      }
    } finally {
      this.isPublishingExplicitAwareness = false;
    }
  }

  setSuppressed(suppressed: boolean): void {
    this.awarenessPublicationSuppressed = suppressed;
  }

  /** Applies an awareness update the room sent; throws when it is malformed. */
  applyRemote(update: Uint8Array): void {
    awarenessProtocol.applyAwarenessUpdate(
      this.options.awareness,
      update,
      COLLABORATION_ORIGIN.remoteProvider,
    );
  }

  /** Drops a throttled local update that has not been sent yet. */
  clear(): void {
    if (this.pendingAwarenessTimer) clearTimeout(this.pendingAwarenessTimer);
    this.pendingAwarenessTimer = null;
    this.pendingAwarenessUpdate = null;
  }

  /** Stops listening to the awareness instance and forgets remote states. */
  dispose(): void {
    this.options.awareness.off("update", this.handleProtocolUpdate);
    this.options.awareness.off("change", this.handleProtocolChange);
    this.remoteAwarenessEvents.clear();
  }

  private readonly handleProtocolUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const { awareness } = this.options;
    if (origin === COLLABORATION_ORIGIN.remoteProvider || !this.options.isLive()) {
      return;
    }
    if (this.awarenessPublicationSuppressed && !this.isPublishingExplicitAwareness) return;
    const changedClients = [...changes.added, ...changes.updated, ...changes.removed];
    if (!changedClients.includes(awareness.clientID)) return;
    const state = awareness.getLocalState();
    if (state !== null && !collaborationAwarenessClientStateSchema.safeParse(state).success) return;
    // Encoded now: a later flush must send this state, not one changed while
    // publication was suppressed.
    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]);
    if (state === null || this.isPublishingExplicitAwareness) {
      // A leave or an explicit publish replaces a throttled state, never follows it.
      this.clear();
      this.send(update);
      return;
    }
    this.pendingAwarenessUpdate = update;
    if (this.pendingAwarenessTimer) return;
    const delay = this.lastAwarenessSentAt + IMPLICIT_AWARENESS_INTERVAL_MS - this.options.now();
    if (delay <= 0) {
      this.flush();
      return;
    }
    this.pendingAwarenessTimer = setTimeout(() => {
      this.pendingAwarenessTimer = null;
      this.flush();
    }, delay);
  };

  private flush(): void {
    const update = this.pendingAwarenessUpdate;
    this.pendingAwarenessUpdate = null;
    if (update && this.options.isLive()) this.send(update);
  }

  private send(update: Uint8Array): void {
    const socket = this.options.openSocket();
    if (!socket) return;
    this.lastAwarenessSentAt = this.options.now();
    try {
      socket.send(encodeCollaborationAwarenessUpdate(update));
    } catch {
      this.options.onSendFailure();
    }
  }

  private readonly handleProtocolChange = (changes: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    for (const clientId of [...changes.added, ...changes.updated]) {
      const state = collaborationAwarenessServerStateSchema.safeParse(
        this.options.awareness.getStates().get(clientId),
      );
      if (!state.success) continue;
      this.remoteAwarenessEvents.set(clientId, state.data.collaboration);
      this.options.onEvent?.(state.data.collaboration);
    }
    for (const clientId of changes.removed) {
      const previous = this.remoteAwarenessEvents.get(clientId);
      this.remoteAwarenessEvents.delete(clientId);
      if (!previous || previous.kind !== "state") continue;
      this.options.onEvent?.({
        kind: "leave",
        roomId: previous.roomId,
        actorId: previous.actorId,
        sessionId: previous.sessionId,
        revision: Math.min(previous.revision + 1, Number.MAX_SAFE_INTEGER),
        occurredAt: Date.now(),
      });
    }
  };
}
