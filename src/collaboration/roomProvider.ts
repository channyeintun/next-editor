import { createActor, type ActorRefFrom, type Subscription } from "xstate";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
  COLLABORATION_BINARY_PROTOCOL_VERSION,
  decodeCollaborationBinaryFrame,
  encodeCollaborationAwarenessUpdate,
  encodeCollaborationClientUpdate,
  encodeCollaborationSyncStep1,
  type CollaborationBinaryFrame,
} from "./binaryProtocol";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_WEBSOCKET_ERROR_STATUS,
  MAX_YJS_UPDATE_BYTES,
  canPublishCollaborationUpdate,
  collaborationAwarenessClientStateSchema,
  collaborationAwarenessServerStateSchema,
  collaborationWebSocketServerMessageSchema,
  type CollaborationAwarenessEvent,
  type CollaborationAwarenessInput,
  type CollaborationControlEvent,
  type CollaborationRoomSession,
  type CollaborationWebSocketServerMessage,
} from "./protocol";
import { messageFromError, requestErrorStatus } from "./errorMessage";
import { COLLABORATION_ORIGIN } from "./projectDocument";
import {
  collaborationConnectionState,
  collaborationMachine,
  type CollaborationConnectionState,
} from "./collaborationMachine";
import { recordPerformanceMetric, startPerformanceSpan } from "../utils/performanceMetrics";

const FAST_WEBSOCKET_BATCH_WINDOW_MS = 16;
const CONGESTED_BATCH_WINDOW_MS = 75;
const MAX_BATCH_UPDATE_COUNT = 32;
const BATCH_MERGE_BUDGET_BYTES = MAX_YJS_UPDATE_BYTES - 1024;
const WEBSOCKET_BACKPRESSURE_BYTES = 64 * 1024;
const BUSY_PENDING_UPDATE_COUNT = 8;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const MAX_SEEN_STREAM_IDS = 2_000;
const WEBSOCKET_ACK_TIMEOUT_MS = 15_000;
const WEBSOCKET_HEARTBEAT_MS = 20_000;
const WEBSOCKET_OPEN = 1;
// y-monaco republishes the local selection on every Monaco selection change,
// each mousemove of a drag-select, and the room accepts 20 awareness frames
// per second per socket, refusing the rest without broadcasting them (the
// final selection among them). Explicit publishes are already throttled by
// the collaboration context and carry the current selection, so they go out
// at once; any other change waits until this long after the last frame of
// either kind, which keeps the total near 13 per second.
const IMPLICIT_AWARENESS_INTERVAL_MS = 150;

export interface CollaborationRoomApi {
  getRoom(roomId: string): Promise<CollaborationRoomSession>;
}

export interface CollaborationWebSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  binaryType?: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | ArrayBufferView<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

export type CollaborationWebSocketFactory = (url: string) => CollaborationWebSocket;

export interface CollaborationRoomProviderOptions {
  roomId: string;
  api: CollaborationRoomApi;
  doc?: Y.Doc;
  clientId?: string;
  webSocketFactory?: CollaborationWebSocketFactory;
  batchWindowMs?: number;
  maxReconnectAttempts?: number;
  random?: () => number;
  onDocumentChange?: (doc: Y.Doc, transaction: Y.Transaction) => void;
  onAwarenessEvent?: (event: CollaborationAwarenessEvent) => void;
  onControlEvent?: (event: CollaborationControlEvent) => void;
  onRejectedLocalChanges?: (message: string) => void;
}

interface PendingUpdate {
  updateId: string;
  update: Uint8Array;
  queuedAt: number;
  firstSentAt?: number;
}

interface PendingLocalUpdate {
  update: Uint8Array;
  queuedAt: number;
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function isFatalRequestError(error: unknown): boolean {
  const status = requestErrorStatus(error);
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 409;
}

function defaultWebSocketFactory(url: string): CollaborationWebSocket {
  return new WebSocket(url);
}

function websocketRequestError(message: string, status = 503): Error {
  const error = new Error(message) as Error & { response?: { status: number } };
  error.response = { status };
  return error;
}

/** Binary WebSocket provider for the room Durable Object. */
export class CollaborationRoomProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly actor: ActorRefFrom<typeof collaborationMachine>;
  readonly clientId: string;

  private readonly api: CollaborationRoomApi;
  private readonly roomId: string;
  private readonly webSocketFactory: CollaborationWebSocketFactory;
  private readonly batchWindowMs: number | null;
  private readonly maxReconnectAttempts: number;
  private readonly random: () => number;
  private readonly onDocumentChange?: CollaborationRoomProviderOptions["onDocumentChange"];
  private readonly onAwarenessEvent?: CollaborationRoomProviderOptions["onAwarenessEvent"];
  private readonly onControlEvent?: CollaborationRoomProviderOptions["onControlEvent"];
  private readonly onRejectedLocalChanges?: CollaborationRoomProviderOptions["onRejectedLocalChanges"];

  private sessionId: string = crypto.randomUUID();
  private attemptId: string = crypto.randomUUID();
  private reconnectAttempt = 0;
  private socket: CollaborationWebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private roomSession: CollaborationRoomSession | null = null;
  private isSynchronizing = false;
  private isStarted = false;
  private isStopped = false;
  /** Set by `fatal()`, cleared only by an explicit `retryNow()`. */
  private isFatal = false;
  private hasDroppedLocalChanges = false;
  private hasCompletedSync = false;
  private isPublishing = false;
  private flushPromise: Promise<void> | null = null;
  private bufferedBinaryUpdates: Array<
    Extract<CollaborationBinaryFrame, { kind: "server-update" }>
  > = [];
  private pendingUpdates: PendingLocalUpdate[] = [];
  private outbox: PendingUpdate[] = [];
  private seenStreamIds = new Set<string>();
  private isRefreshingControl = false;
  private pendingControlRoleVersion = 0;
  private readonly remoteAwarenessEvents = new Map<number, CollaborationAwarenessEvent>();
  private pendingBinarySync: {
    attemptId: string;
    resolve: (update: Uint8Array) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly pendingWebSocketAcks = new Map<
    string,
    {
      resolve: () => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private awarenessPublicationSuppressed = false;
  private isPublishingExplicitAwareness = false;
  private lastAwarenessSentAt = Number.NEGATIVE_INFINITY;
  private pendingAwarenessUpdate: Uint8Array | null = null;
  private pendingAwarenessTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CollaborationRoomProviderOptions) {
    this.roomId = options.roomId;
    this.api = options.api;
    this.doc = options.doc ?? new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.clientId = options.clientId ?? crypto.randomUUID();
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.batchWindowMs = options.batchWindowMs ?? null;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.random = options.random ?? Math.random;
    this.onDocumentChange = options.onDocumentChange;
    this.onAwarenessEvent = options.onAwarenessEvent;
    this.onControlEvent = options.onControlEvent;
    this.onRejectedLocalChanges = options.onRejectedLocalChanges;
    this.actor = createActor(collaborationMachine);
    this.awareness.on("update", this.handleAwarenessProtocolUpdate);
    this.awareness.on("change", this.handleAwarenessProtocolChange);
  }

  get connectionState(): CollaborationConnectionState {
    return collaborationConnectionState(this.actor.getSnapshot().value);
  }

  get session(): CollaborationRoomSession | null {
    return this.roomSession;
  }

  get awarenessSessionId(): string {
    return this.sessionId;
  }

  get canWrite(): boolean {
    return Boolean(
      this.roomSession && canPublishCollaborationUpdate(this.roomSession.membership.role),
    );
  }

  get hasPendingUpdates(): boolean {
    return this.pendingUpdates.length > 0 || this.outbox.length > 0 || this.isPublishing;
  }

  /**
   * True once a sync has completed. From then on the document holds the room's
   * state, so local edits made while reconnecting are real edits to queue.
   */
  get hasSynced(): boolean {
    return this.hasCompletedSync;
  }

  /**
   * True once local edits were dropped, because the room refused them or because
   * one change was too large to send. They stay integrated in `doc`, and
   * reconnect sync only pulls the room's state, so this document can never match
   * the room again: a retry has to start from a fresh provider, not `retryNow()`.
   */
  get hasDivergedDocument(): boolean {
    return this.hasDroppedLocalChanges;
  }

  subscribe(listener: () => void): Subscription {
    return this.actor.subscribe(listener);
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;
    this.isStopped = false;
    this.actor.start();
    this.doc.on("update", this.handleDocumentUpdate);
    this.doc.on("afterTransaction", this.handleAfterTransaction);
    this.actor.send({
      type: "CONNECT",
      sessionId: this.sessionId,
      attemptId: this.attemptId,
    });
    await this.connectAttempt(this.attemptId);
  }

  stop(): void {
    if (this.isStopped) return;
    this.isStopped = true;
    this.closeTransport();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.reconnectTimer = null;
    this.batchTimer = null;
    this.clearPendingAwareness();
    this.doc.off("update", this.handleDocumentUpdate);
    this.doc.off("afterTransaction", this.handleAfterTransaction);
    this.awareness.off("update", this.handleAwarenessProtocolUpdate);
    this.awareness.off("change", this.handleAwarenessProtocolChange);
    this.awareness.destroy();
    this.remoteAwarenessEvents.clear();
    this.pendingUpdates = [];
    this.outbox = [];
    this.bufferedBinaryUpdates = [];
    this.actor.send({ type: "LEAVE" });
    this.actor.stop();
  }

  async retryNow(): Promise<void> {
    if (this.isStopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    // An explicit user retry is the only way out of a fatal.
    this.isFatal = false;
    await this.beginRetry();
  }

  async flushNow(): Promise<void> {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.movePendingUpdatesToOutbox();
    await this.flushOutbox();
  }

  async publishAwareness(input: CollaborationAwarenessInput): Promise<void> {
    const session = this.roomSession;
    if (!session || this.connectionState !== "live") return;
    this.isPublishingExplicitAwareness = true;
    try {
      if (input.kind === "leave") {
        this.awareness.setLocalState(null);
      } else {
        const selection =
          input.surface.kind === "editor" && !this.awarenessPublicationSuppressed
            ? this.awareness.getLocalState()?.selection
            : null;
        this.awareness.setLocalState(
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

  setAwarenessPublicationSuppressed(suppressed: boolean): void {
    this.awarenessPublicationSuppressed = suppressed;
  }

  private readonly handleAfterTransaction = (transaction: Y.Transaction) => {
    this.onDocumentChange?.(this.doc, transaction);
  };

  private readonly handleAwarenessProtocolUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === COLLABORATION_ORIGIN.remoteProvider || this.connectionState !== "live") {
      return;
    }
    if (this.awarenessPublicationSuppressed && !this.isPublishingExplicitAwareness) return;
    const changedClients = [...changes.added, ...changes.updated, ...changes.removed];
    if (!changedClients.includes(this.awareness.clientID)) return;
    const state = this.awareness.getLocalState();
    if (state !== null && !collaborationAwarenessClientStateSchema.safeParse(state).success) return;
    // Encoded now: a later flush must send this state, not one changed while
    // publication was suppressed.
    const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
      this.awareness.clientID,
    ]);
    if (state === null || this.isPublishingExplicitAwareness) {
      // A leave or an explicit publish replaces a throttled state, never follows it.
      this.clearPendingAwareness();
      this.sendAwarenessUpdate(update);
      return;
    }
    this.pendingAwarenessUpdate = update;
    if (this.pendingAwarenessTimer) return;
    const delay = this.lastAwarenessSentAt + IMPLICIT_AWARENESS_INTERVAL_MS - monotonicNow();
    if (delay <= 0) {
      this.flushPendingAwareness();
      return;
    }
    this.pendingAwarenessTimer = setTimeout(() => {
      this.pendingAwarenessTimer = null;
      this.flushPendingAwareness();
    }, delay);
  };

  private flushPendingAwareness(): void {
    const update = this.pendingAwarenessUpdate;
    this.pendingAwarenessUpdate = null;
    if (update && this.connectionState === "live") this.sendAwarenessUpdate(update);
  }

  private clearPendingAwareness(): void {
    if (this.pendingAwarenessTimer) clearTimeout(this.pendingAwarenessTimer);
    this.pendingAwarenessTimer = null;
    this.pendingAwarenessUpdate = null;
  }

  private sendAwarenessUpdate(update: Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) return;
    this.lastAwarenessSentAt = monotonicNow();
    try {
      socket.send(encodeCollaborationAwarenessUpdate(update));
    } catch {
      this.handleTransportFailure("Collaboration awareness could not be delivered", this.attemptId);
    }
  }

  private readonly handleAwarenessProtocolChange = (changes: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    for (const clientId of [...changes.added, ...changes.updated]) {
      const state = collaborationAwarenessServerStateSchema.safeParse(
        this.awareness.getStates().get(clientId),
      );
      if (!state.success) continue;
      this.remoteAwarenessEvents.set(clientId, state.data.collaboration);
      this.onAwarenessEvent?.(state.data.collaboration);
    }
    for (const clientId of changes.removed) {
      const previous = this.remoteAwarenessEvents.get(clientId);
      this.remoteAwarenessEvents.delete(clientId);
      if (!previous || previous.kind !== "state") continue;
      this.onAwarenessEvent?.({
        kind: "leave",
        roomId: previous.roomId,
        actorId: previous.actorId,
        sessionId: previous.sessionId,
        revision: Math.min(previous.revision + 1, Number.MAX_SAFE_INTEGER),
        occurredAt: Date.now(),
      });
    }
  };

  private readonly handleDocumentUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === COLLABORATION_ORIGIN.remoteProvider || !this.canWrite) return;
    this.pendingUpdates.push({ update, queuedAt: monotonicNow() });
    this.reportPendingUpdates();
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.movePendingUpdatesToOutbox();
      void this.flushOutbox();
    }, this.currentBatchWindowMs());
  };

  private currentBatchWindowMs(): number {
    if (this.batchWindowMs !== null) return this.batchWindowMs;
    if (
      (this.socket?.bufferedAmount ?? 0) >= WEBSOCKET_BACKPRESSURE_BYTES ||
      this.pendingUpdates.length >= BUSY_PENDING_UPDATE_COUNT ||
      this.outbox.length >= 4
    ) {
      return CONGESTED_BATCH_WINDOW_MS;
    }
    return FAST_WEBSOCKET_BATCH_WINDOW_MS;
  }

  private movePendingUpdatesToOutbox(): void {
    if (this.pendingUpdates.length === 0) return;
    const updates = this.pendingUpdates;
    this.pendingUpdates = [];

    let batch: PendingLocalUpdate[] = [];
    let batchBytes = 0;
    const enqueueBatch = () => {
      const first = batch[0];
      if (!first) return;
      const update =
        batch.length === 1 ? first.update : Y.mergeUpdates(batch.map((item) => item.update));
      // Only a merged batch can land here: the loop below rejects a single
      // oversize update before batching it. Send the parts unmerged instead.
      if (update.byteLength > MAX_YJS_UPDATE_BYTES) {
        for (const pending of batch) {
          this.outbox.push({
            updateId: crypto.randomUUID(),
            update: pending.update,
            queuedAt: pending.queuedAt,
          });
        }
        batch = [];
        batchBytes = 0;
        return;
      }
      this.outbox.push({
        updateId: crypto.randomUUID(),
        update,
        queuedAt: first.queuedAt,
      });
      batch = [];
      batchBytes = 0;
    };
    for (const pending of updates) {
      const { update } = pending;
      if (update.byteLength > MAX_YJS_UPDATE_BYTES) {
        // The room refuses an update this large, and nothing here can split one:
        // y-monaco writes a whole Monaco change event (a large paste) in one
        // transaction, and Y.UndoManager restores a large delete in one. The
        // change is already in `doc` and every later local edit builds on it, so
        // this document can never match the room again. Drop every local edit
        // the room has not acknowledged, including ones queued before this change
        // that a resume could still deliver, and fail, so a retry rebuilds from
        // the room. This is the same trade as a role change (applyRoomSession).
        this.dropLocalChanges();
        const message = `A change was larger than a live room accepts (${MAX_YJS_UPDATE_BYTES / 1024} KiB). Copy any local work before rejoining.`;
        this.onRejectedLocalChanges?.(message);
        this.fatal(message);
        return;
      }
      if (
        batch.length >= MAX_BATCH_UPDATE_COUNT ||
        (batch.length > 0 && batchBytes + update.byteLength > BATCH_MERGE_BUDGET_BYTES)
      ) {
        enqueueBatch();
      }
      batch.push(pending);
      batchBytes += update.byteLength;
    }
    enqueueBatch();
  }

  /**
   * Folds the unsent entries queued behind the head into it before it is sent.
   * The outbox is stop-and-wait, so each batch flushed while an update awaits
   * its ack becomes its own entry; sent one per round trip, a writer who types
   * faster than the RTT falls further behind with every key. Yjs updates merge
   * losslessly and the room has never seen these updateIds. An entry that was
   * sent keeps its updateId and bytes, so its retry stays idempotent.
   */
  private mergeUnsentOutboxHead(): void {
    const head = this.outbox[0];
    if (!head || head.firstSentAt !== undefined) return;
    let count = 1;
    let bytes = head.update.byteLength;
    while (count < this.outbox.length && count < MAX_BATCH_UPDATE_COUNT) {
      const next = this.outbox[count];
      if (next.firstSentAt !== undefined) break;
      if (bytes + next.update.byteLength > BATCH_MERGE_BUDGET_BYTES) break;
      bytes += next.update.byteLength;
      count += 1;
    }
    if (count === 1) return;
    const update = Y.mergeUpdates(this.outbox.slice(0, count).map((entry) => entry.update));
    // As in movePendingUpdatesToOutbox: a merge past the limit is sent unmerged.
    if (update.byteLength > MAX_YJS_UPDATE_BYTES) return;
    this.outbox.splice(0, count, { updateId: head.updateId, update, queuedAt: head.queuedAt });
  }

  private async connectAttempt(attemptId: string): Promise<void> {
    try {
      const roomSession = await this.api.getRoom(this.roomId);
      if (this.isStopped || attemptId !== this.attemptId) return;
      if (
        roomSession.room.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
        roomSession.room.documentSchemaVersion !== COLLABORATION_DOCUMENT_SCHEMA_VERSION
      ) {
        this.fatal("This room uses an unsupported collaboration protocol", attemptId);
        return;
      }
      if (roomSession.room.status !== "active") {
        this.fatal("This collaboration room is no longer active", attemptId);
        return;
      }
      if (!this.applyRoomSession(roomSession, attemptId)) return;
      if (roomSession.room.roleVersion >= this.pendingControlRoleVersion) {
        this.pendingControlRoleVersion = 0;
      }
      this.openSocket(attemptId);
    } catch (error) {
      if (this.isStopped || attemptId !== this.attemptId) return;
      if (isFatalRequestError(error)) {
        this.fatal(messageFromError(error, "This collaboration room is unavailable"), attemptId);
      } else {
        this.handleTransportFailure(
          messageFromError(error, "The collaboration room could not be reached"),
          attemptId,
        );
      }
    }
  }

  private openSocket(attemptId: string): void {
    this.closeTransport();
    const url = new URL(
      `/api/collaboration/rooms/${encodeURIComponent(this.roomId)}/websocket`,
      window.location.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("sessionId", this.sessionId);
    url.searchParams.set("attemptId", attemptId);
    url.searchParams.set("binaryProtocolVersion", String(COLLABORATION_BINARY_PROTOCOL_VERSION));
    const socket = this.webSocketFactory(url.toString());
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    // The room answers every "ping" with "pong" (a Durable Object auto-response),
    // so a ping still unanswered at the next heartbeat means a dead path the
    // browser has not noticed yet. Heartbeats are counted, not timed: Chrome runs
    // a hidden tab's interval as rarely as once a minute, and an open WebSocket
    // does not exempt it.
    let isAwaitingReply = false;
    socket.onopen = () => {
      if (this.isStopped || attemptId !== this.attemptId || socket !== this.socket) return;
      this.actor.send({ type: "PROVIDER_OPEN", sessionId: this.sessionId, attemptId });
      this.heartbeatTimer = setInterval(() => {
        if (socket !== this.socket || socket.readyState !== WEBSOCKET_OPEN) return;
        if (isAwaitingReply) {
          this.handleTransportFailure("Collaboration WebSocket stopped responding", attemptId);
          return;
        }
        isAwaitingReply = true;
        socket.send("ping");
      }, WEBSOCKET_HEARTBEAT_MS);
      void this.synchronizeBinary(attemptId);
    };
    socket.onmessage = (event) => {
      if (this.isStopped || attemptId !== this.attemptId || socket !== this.socket) return;
      isAwaitingReply = false;
      if (event.data === "pong") return;
      this.handleWebSocketMessage(event.data, attemptId);
    };
    socket.onerror = () => {
      if (this.isStopped || attemptId !== this.attemptId || socket !== this.socket) return;
      this.handleTransportFailure("WebSocket connection interrupted", attemptId);
    };
    socket.onclose = (event) => {
      if (this.isStopped || attemptId !== this.attemptId || socket !== this.socket) return;
      if (event.code === 4001) {
        this.fatal("The host ended this live collaboration room", attemptId);
      } else if (event.code === 4003) {
        this.fatal("You no longer have access to this collaboration room", attemptId);
      } else {
        this.handleTransportFailure("WebSocket connection closed", attemptId);
      }
    };
  }

  private handleWebSocketMessage(raw: unknown, attemptId: string): void {
    if (raw instanceof ArrayBuffer) {
      this.handleBinaryWebSocketMessage(raw, attemptId);
      return;
    }
    if (typeof raw !== "string") {
      this.handleTransportFailure("WebSocket provider sent an invalid message", attemptId);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    const parsed = collaborationWebSocketServerMessageSchema.safeParse(value);
    if (!parsed.success) return;
    const message = parsed.data;
    // The room's handshake acknowledgement; synchronization starts on open.
    if (message.type === "session.ready") return;
    if (message.type === "document.ack") {
      const pending = this.pendingWebSocketAcks.get(message.updateId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingWebSocketAcks.delete(message.updateId);
      pending.resolve();
      return;
    }
    if (message.type === "control.room") {
      this.onControlEvent?.(message.data);
      if (message.data.kind === "room-closed") {
        this.fatal("The host ended this live collaboration room", attemptId);
      } else {
        void this.refreshRoomFromControl(message.data);
      }
      return;
    }
    this.handleWebSocketError(message, attemptId);
  }

  private handleBinaryWebSocketMessage(raw: ArrayBuffer, attemptId: string): void {
    let frame: CollaborationBinaryFrame;
    try {
      frame = decodeCollaborationBinaryFrame(raw);
    } catch {
      this.handleTransportFailure("WebSocket provider sent an invalid binary message", attemptId);
      return;
    }
    if (frame.kind === "awareness") {
      try {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          frame.update,
          COLLABORATION_ORIGIN.remoteProvider,
        );
      } catch {
        this.handleTransportFailure("WebSocket provider sent invalid awareness", attemptId);
      }
      return;
    }
    if (frame.kind === "sync") {
      const pending = this.pendingBinarySync;
      if (
        !pending ||
        pending.attemptId !== attemptId ||
        frame.messageType !== syncProtocol.messageYjsSyncStep2
      ) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingBinarySync = null;
      pending.resolve(frame.payload);
      return;
    }
    if (frame.kind !== "server-update") return;
    if (this.isSynchronizing) {
      this.bufferedBinaryUpdates.push(frame);
    } else {
      this.applyBinaryServerUpdate(frame);
    }
  }

  private applyBinaryServerUpdate(
    frame: Extract<CollaborationBinaryFrame, { kind: "server-update" }>,
  ): void {
    if (this.seenStreamIds.has(frame.streamId)) return;
    const endApplySpan = startPerformanceSpan("collaboration.remote_apply", {
      transport: "cloudflare-websocket",
      wire: "binary",
    });
    Y.applyUpdate(this.doc, frame.update, COLLABORATION_ORIGIN.remoteProvider);
    endApplySpan();
    recordPerformanceMetric("collaboration.remote_update", frame.update.byteLength, "bytes", {
      transport: "cloudflare-websocket",
      wire: "binary",
    });
    this.markStreamIdSeen(frame.streamId);
  }

  private handleWebSocketError(
    message: Extract<CollaborationWebSocketServerMessage, { type: "error" }>,
    attemptId: string,
  ): void {
    const status = COLLABORATION_WEBSOCKET_ERROR_STATUS[message.code];
    if (message.updateId) {
      const pending = this.pendingWebSocketAcks.get(message.updateId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingWebSocketAcks.delete(message.updateId);
        pending.reject(websocketRequestError(message.message, status));
      }
    }
    if (message.fatal) {
      this.fatal(message.message, attemptId);
    } else if (!message.updateId && message.code !== "rate-limited") {
      this.handleTransportFailure(message.message, attemptId);
    }
  }

  private markStreamIdSeen(streamId: string): void {
    this.seenStreamIds.add(streamId);
    if (this.seenStreamIds.size > MAX_SEEN_STREAM_IDS) {
      const oldest = this.seenStreamIds.values().next().value;
      if (oldest) this.seenStreamIds.delete(oldest);
    }
  }

  private async refreshRoomFromControl(event: CollaborationControlEvent): Promise<void> {
    if (this.isStopped || (this.roomSession?.room.roleVersion ?? 0) >= event.roleVersion) return;
    this.pendingControlRoleVersion = Math.max(this.pendingControlRoleVersion, event.roleVersion);
    if (this.isRefreshingControl) return;
    this.isRefreshingControl = true;
    try {
      while (
        !this.isStopped &&
        (this.roomSession?.room.roleVersion ?? 0) < this.pendingControlRoleVersion
      ) {
        const requestedRoleVersion = this.pendingControlRoleVersion;
        const previousRoleVersion = this.roomSession?.room.roleVersion ?? 0;
        const roomSession = await this.api.getRoom(this.roomId);
        if (this.isStopped) return;
        if (roomSession.room.status !== "active") {
          this.fatal("The host ended this live collaboration room");
          return;
        }
        const accepted = this.applyRoomSession(roomSession);
        this.actor.send({ type: "SESSION_REFRESHED" });
        if (!accepted) return;
        if (
          roomSession.room.roleVersion < requestedRoleVersion &&
          roomSession.room.roleVersion <= previousRoleVersion
        ) {
          throw new Error("Room permissions response did not include the latest role change");
        }
      }
    } catch (error) {
      if (this.isStopped) return;
      if (isFatalRequestError(error)) {
        this.fatal(messageFromError(error, "You no longer have access to this collaboration room"));
      } else {
        this.handleTransportFailure(
          messageFromError(error, "Room permissions could not be refreshed"),
          this.attemptId,
        );
      }
    } finally {
      if ((this.roomSession?.room.roleVersion ?? 0) >= this.pendingControlRoleVersion) {
        this.pendingControlRoleVersion = 0;
      }
      this.isRefreshingControl = false;
    }
  }

  /**
   * Stores a refreshed room session. Edits made as a writer that the room has
   * not acknowledged can no longer be sent once the role stops allowing writes,
   * wherever the new role was learned (a control event, or the room request of
   * a reconnect after a downgrade while offline): drop them, tell the user and
   * fail, rather than leaving them in the outbox with nothing reporting them.
   */
  private applyRoomSession(
    roomSession: CollaborationRoomSession,
    attemptId = this.attemptId,
  ): boolean {
    const couldWrite = this.canWrite;
    this.roomSession = roomSession;
    if (!couldWrite || this.canWrite || !this.hasPendingUpdates) return true;
    this.dropLocalChanges();
    const message =
      "Your role changed before local edits were accepted. Copy any local work before rejoining.";
    this.onRejectedLocalChanges?.(message);
    this.fatal(message, attemptId);
    return false;
  }

  private async synchronizeBinary(attemptId: string): Promise<void> {
    if (this.isSynchronizing) return;
    this.isSynchronizing = true;
    const endSynchronizationSpan = startPerformanceSpan("collaboration.bootstrap", {
      transport: "cloudflare-websocket",
      wire: "binary",
    });
    let synchronizationOutcome = "success";
    try {
      const socket = this.socket;
      if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
        throw websocketRequestError("Collaboration WebSocket is not connected");
      }
      const update = await new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = this.pendingBinarySync;
          if (!pending || pending.attemptId !== attemptId || pending.timer !== timer) return;
          this.pendingBinarySync = null;
          pending.reject(websocketRequestError("Collaboration synchronization timed out"));
        }, WEBSOCKET_ACK_TIMEOUT_MS);
        this.pendingBinarySync = { attemptId, resolve, reject, timer };
        try {
          socket.send(encodeCollaborationSyncStep1(this.doc));
        } catch (error) {
          clearTimeout(timer);
          if (this.pendingBinarySync?.timer === timer) this.pendingBinarySync = null;
          reject(error instanceof Error ? error : websocketRequestError("WebSocket send failed"));
        }
      });
      if (this.isStopped || attemptId !== this.attemptId) return;

      Y.applyUpdate(this.doc, update, COLLABORATION_ORIGIN.remoteProvider);
      // Server updates that arrived while the snapshot was requested. Nothing can
      // be buffered after this: socket messages are separate tasks, and there is
      // no await between here and flushOutbox.
      const buffered = this.bufferedBinaryUpdates;
      this.bufferedBinaryUpdates = [];
      this.isSynchronizing = false;
      for (const frame of buffered) this.applyBinaryServerUpdate(frame);
      this.hasCompletedSync = true;
      this.actor.send({ type: "SYNCED", sessionId: this.sessionId, attemptId });
      this.reconnectAttempt = 0;
      await this.flushOutbox();
    } catch (error) {
      synchronizationOutcome = "failure";
      if (this.isStopped || attemptId !== this.attemptId) return;
      if (isFatalRequestError(error)) {
        this.fatal(
          messageFromError(error, "Collaboration synchronization was rejected"),
          attemptId,
        );
      } else {
        this.handleTransportFailure(
          messageFromError(error, "Collaboration synchronization failed"),
          attemptId,
        );
      }
    } finally {
      this.isSynchronizing = false;
      endSynchronizationSpan({ outcome: synchronizationOutcome });
    }
  }

  private flushOutbox(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (this.connectionState !== "live" || !this.canWrite) return Promise.resolve();
    const promise = this.drainOutbox();
    this.flushPromise = promise;
    return promise.finally(() => {
      if (this.flushPromise === promise) this.flushPromise = null;
      if (
        !this.isStopped &&
        this.connectionState === "live" &&
        this.outbox.length > 0 &&
        this.canWrite
      ) {
        void this.flushOutbox();
      }
    });
  }

  private async drainOutbox(): Promise<void> {
    this.isPublishing = true;
    try {
      while (!this.isStopped && this.connectionState === "live" && this.outbox.length > 0) {
        this.mergeUnsentOutboxHead();
        const pending = this.outbox[0];
        const sentAt = monotonicNow();
        const transport = "cloudflare-websocket";
        if (pending.firstSentAt === undefined) {
          pending.firstSentAt = sentAt;
          recordPerformanceMetric(
            "collaboration.queue_to_send",
            Math.max(0, sentAt - pending.queuedAt),
            "ms",
            { transport },
          );
        }
        try {
          await this.publishTransportUpdate(pending);
          const acknowledgedAt = monotonicNow();
          recordPerformanceMetric(
            "collaboration.send_to_ack",
            Math.max(0, acknowledgedAt - sentAt),
            "ms",
            { outcome: "success", transport },
          );
          recordPerformanceMetric(
            "collaboration.enqueue_to_ack",
            Math.max(0, acknowledgedAt - pending.queuedAt),
            "ms",
            { transport },
          );
          this.outbox.shift();
        } catch (error) {
          recordPerformanceMetric(
            "collaboration.send_to_ack",
            Math.max(0, monotonicNow() - sentAt),
            "ms",
            { outcome: "failure", transport },
          );
          if (requestErrorStatus(error) === 403) {
            await this.handleWriteRejection(error);
          } else if (isFatalRequestError(error)) {
            this.fatal(messageFromError(error, "A collaboration update was rejected"));
          } else {
            this.handleTransportFailure(
              messageFromError(error, "A collaboration update could not be delivered"),
              this.attemptId,
            );
          }
          return;
        }
      }
    } finally {
      this.isPublishing = false;
      this.reportPendingUpdates();
    }
  }

  /**
   * Tells the machine when unacknowledged local edits appear or are all gone.
   * Only the edges are sent: a keystroke must not become an actor snapshot (and
   * a re-render of every collaboration consumer).
   */
  private reportPendingUpdates(): void {
    if (this.isStopped) return;
    const hasPendingUpdates = this.hasPendingUpdates;
    if (hasPendingUpdates === this.actor.getSnapshot().context.hasOfflineChanges) return;
    this.actor.send({ type: hasPendingUpdates ? "OFFLINE_CHANGES" : "CHANGES_FLUSHED" });
  }

  /** Sends one update and settles when the room acknowledges or rejects its updateId. */
  private publishTransportUpdate(pending: PendingUpdate): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
      return Promise.reject(websocketRequestError("Collaboration WebSocket is not connected"));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWebSocketAcks.delete(pending.updateId);
        reject(websocketRequestError("Collaboration update acknowledgement timed out"));
      }, WEBSOCKET_ACK_TIMEOUT_MS);
      this.pendingWebSocketAcks.set(pending.updateId, { resolve, reject, timer });
      try {
        socket.send(
          encodeCollaborationClientUpdate({
            clientId: this.clientId,
            updateId: pending.updateId,
            update: pending.update,
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pendingWebSocketAcks.delete(pending.updateId);
        reject(error instanceof Error ? error : websocketRequestError("WebSocket send failed"));
      }
    });
  }

  private async handleWriteRejection(error: unknown): Promise<void> {
    try {
      const roomSession = await this.api.getRoom(this.roomId);
      this.roomSession = roomSession;
      this.actor.send({ type: "SESSION_REFRESHED" });
    } catch {
      // The original permission response remains the actionable failure.
    }
    this.dropLocalChanges();
    const message =
      "Your role changed before offline edits were accepted. Copy any local work before rejoining.";
    this.onRejectedLocalChanges?.(message);
    this.fatal(messageFromError(error, message));
  }

  /** Discards every unacknowledged local edit, including ones still batching. */
  private dropLocalChanges(): void {
    this.pendingUpdates = [];
    this.outbox = [];
    this.hasDroppedLocalChanges = true;
    this.reportPendingUpdates();
  }

  private handleTransportFailure(message: string, attemptId: string): void {
    if (this.isStopped || this.isFatal || attemptId !== this.attemptId) return;
    if (this.reconnectTimer) return;
    this.closeTransport();
    this.actor.send({
      type: "DISCONNECTED",
      sessionId: this.sessionId,
      attemptId,
      message,
    });
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.fatal("Collaboration reconnect attempts were exhausted", attemptId);
      return;
    }
    const baseDelay = Math.min(500 * 2 ** this.reconnectAttempt, 10_000);
    const jitter = Math.floor(baseDelay * 0.25 * this.random());
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.beginRetry();
    }, baseDelay + jitter);
  }

  private async beginRetry(): Promise<void> {
    if (this.isStopped) return;
    this.attemptId = crypto.randomUUID();
    this.actor.send({
      type: "RETRY",
      sessionId: this.sessionId,
      attemptId: this.attemptId,
    });
    await this.connectAttempt(this.attemptId);
  }

  private fatal(message: string, attemptId = this.attemptId): void {
    if (this.isStopped || attemptId !== this.attemptId) return;
    // Closing the transport rejects every pending ack with a 503, which lands in
    // drainOutbox's catch and calls handleTransportFailure — which used to
    // schedule an automatic reconnect out of the failed state and null the error
    // on the way through. For fatals with no localError counterpart (a 4001
    // host-ended close, exhausted reconnects) the machine's context is the only
    // carrier of that message, so the user was returned to an apparently healthy
    // room with no explanation.
    this.isFatal = true;
    this.closeTransport();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.actor.send({
      type: "FATAL_ERROR",
      sessionId: this.sessionId,
      attemptId,
      message,
    });
  }

  private closeTransport(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const socket = this.socket;
    this.socket = null;
    const pendingSync = this.pendingBinarySync;
    this.pendingBinarySync = null;
    if (pendingSync) {
      clearTimeout(pendingSync.timer);
      pendingSync.reject(websocketRequestError("Collaboration WebSocket disconnected"));
    }
    this.bufferedBinaryUpdates = [];
    for (const [updateId, pending] of this.pendingWebSocketAcks) {
      clearTimeout(pending.timer);
      pending.reject(websocketRequestError("Collaboration WebSocket disconnected"));
      this.pendingWebSocketAcks.delete(updateId);
    }
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close(1000, "provider closed");
  }
}
