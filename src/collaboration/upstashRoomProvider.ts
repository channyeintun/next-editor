import { createActor, type ActorRefFrom, type Subscription } from "xstate";
import * as Y from "yjs";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  MAX_YJS_UPDATE_BYTES,
  collaborationAwarenessChannel,
  collaborationAwarenessEventSchema,
  collaborationControlChannel,
  collaborationControlEventSchema,
  collaborationDocumentUpdateEventSchema,
  collaborationRoomChannel,
  collaborationWebSocketClientMessageSchema,
  collaborationWebSocketServerMessageSchema,
  type CollaborationAwarenessEvent,
  type CollaborationAwarenessInput,
  type CollaborationBootstrapResponse,
  type CollaborationControlEvent,
  type CollaborationDocumentUpdateInput,
  type CollaborationRoomSession,
  type CollaborationUpdateAccepted,
  type CollaborationWebSocketServerMessage,
} from "./protocol";
import { COLLABORATION_ORIGIN, canWriteCollaborationDocument } from "./projectDocument";
import {
  applyEncodedYjsSnapshot,
  applyEncodedYjsUpdate,
  createCollaborationDocumentUpdate,
} from "./yjsUpdates";
import {
  collaborationConnectionState,
  collaborationMachine,
  type CollaborationConnectionState,
} from "./collaborationMachine";

const DEFAULT_BATCH_WINDOW_MS = 75;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const MAX_BOOTSTRAP_PAGES = 1_000;
const MAX_SEEN_STREAM_IDS = 2_000;
const WEBSOCKET_ACK_TIMEOUT_MS = 15_000;
const WEBSOCKET_HEARTBEAT_MS = 20_000;
const WEBSOCKET_OPEN = 1;

export interface CollaborationRoomApi {
  getRoom(roomId: string): Promise<CollaborationRoomSession>;
  getBootstrap(roomId: string, cursor?: string): Promise<CollaborationBootstrapResponse>;
  publishUpdate(
    roomId: string,
    update: CollaborationDocumentUpdateInput,
  ): Promise<CollaborationUpdateAccepted>;
  publishAwareness(
    roomId: string,
    awareness: CollaborationAwarenessInput,
  ): Promise<{ accepted: true; streamId: string; event: CollaborationAwarenessEvent }>;
}

export interface CollaborationEventSource {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type CollaborationEventSourceFactory = (url: string) => CollaborationEventSource;

export interface CollaborationWebSocket {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type CollaborationWebSocketFactory = (url: string) => CollaborationWebSocket;

export interface UpstashRoomProviderOptions {
  roomId: string;
  api: CollaborationRoomApi;
  doc?: Y.Doc;
  clientId?: string;
  eventSourceFactory?: CollaborationEventSourceFactory;
  webSocketFactory?: CollaborationWebSocketFactory;
  batchWindowMs?: number;
  maxReconnectAttempts?: number;
  random?: () => number;
  onDocumentChange?: (doc: Y.Doc, transaction: Y.Transaction) => void;
  onAwarenessEvent?: (event: CollaborationAwarenessEvent) => void;
  onControlEvent?: (event: CollaborationControlEvent) => void;
  onRejectedLocalChanges?: (message: string) => void;
}

interface RealtimeUserMessage {
  id: string;
  event: string;
  channel: string;
  data: unknown;
}

interface PendingUpdate {
  input: CollaborationDocumentUpdateInput;
}

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const response = (error as { response?: { status?: unknown } }).response;
  return typeof response?.status === "number" ? response.status : null;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function isFatalRequestError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 409;
}

function compareStreamIds(left: string, right: string): number {
  const [leftTime = "0", leftSequence = "0"] = left.split("-");
  const [rightTime = "0", rightSequence = "0"] = right.split("-");
  const timeDifference = BigInt(leftTime) - BigInt(rightTime);
  if (timeDifference !== 0n) return timeDifference < 0n ? -1 : 1;
  const sequenceDifference = BigInt(leftSequence) - BigInt(rightSequence);
  return sequenceDifference === 0n ? 0 : sequenceDifference < 0n ? -1 : 1;
}

function parseRealtimeUserMessage(value: unknown): RealtimeUserMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<RealtimeUserMessage>;
  return typeof candidate.id === "string" &&
    typeof candidate.event === "string" &&
    typeof candidate.channel === "string"
    ? (candidate as RealtimeUserMessage)
    : null;
}

function defaultEventSourceFactory(url: string): CollaborationEventSource {
  return new EventSource(url, { withCredentials: true });
}

function defaultWebSocketFactory(url: string): CollaborationWebSocket {
  return new WebSocket(url);
}

function websocketRequestError(message: string, status = 503): Error {
  const error = new Error(message) as Error & { response?: { status: number } };
  error.response = { status };
  return error;
}

export class UpstashRoomProvider {
  readonly doc: Y.Doc;
  readonly actor: ActorRefFrom<typeof collaborationMachine>;
  readonly clientId: string;

  private readonly api: CollaborationRoomApi;
  private readonly roomId: string;
  private readonly eventSourceFactory: CollaborationEventSourceFactory;
  private readonly webSocketFactory: CollaborationWebSocketFactory;
  private readonly batchWindowMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly random: () => number;
  private readonly onDocumentChange?: UpstashRoomProviderOptions["onDocumentChange"];
  private readonly onAwarenessEvent?: UpstashRoomProviderOptions["onAwarenessEvent"];
  private readonly onControlEvent?: UpstashRoomProviderOptions["onControlEvent"];
  private readonly onRejectedLocalChanges?: UpstashRoomProviderOptions["onRejectedLocalChanges"];

  private sessionId: string = crypto.randomUUID();
  private attemptId: string = crypto.randomUUID();
  private reconnectAttempt = 0;
  private source: CollaborationEventSource | null = null;
  private socket: CollaborationWebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private roomSession: CollaborationRoomSession | null = null;
  private isSynchronizing = false;
  private isStarted = false;
  private isStopped = false;
  private isPublishing = false;
  private readonly lastAcknowledgedStreamIds = new Map<string, string>();
  private bufferedMessages: RealtimeUserMessage[] = [];
  private pendingUpdates: Uint8Array[] = [];
  private outbox: PendingUpdate[] = [];
  private seenStreamIds = new Set<string>();
  private isRefreshingControl = false;
  private pendingControlRoleVersion = 0;
  private readonly pendingWebSocketAcks = new Map<
    string,
    {
      resolve: (value: CollaborationUpdateAccepted) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(options: UpstashRoomProviderOptions) {
    this.roomId = options.roomId;
    this.api = options.api;
    this.doc = options.doc ?? new Y.Doc();
    this.clientId = options.clientId ?? crypto.randomUUID();
    this.eventSourceFactory = options.eventSourceFactory ?? defaultEventSourceFactory;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.random = options.random ?? Math.random;
    this.onDocumentChange = options.onDocumentChange;
    this.onAwarenessEvent = options.onAwarenessEvent;
    this.onControlEvent = options.onControlEvent;
    this.onRejectedLocalChanges = options.onRejectedLocalChanges;
    this.actor = createActor(collaborationMachine);
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
      this.roomSession && canWriteCollaborationDocument(this.roomSession.membership.role),
    );
  }

  get hasPendingUpdates(): boolean {
    return this.pendingUpdates.length > 0 || this.outbox.length > 0 || this.isPublishing;
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
      roomId: this.roomId,
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
    this.doc.off("update", this.handleDocumentUpdate);
    this.doc.off("afterTransaction", this.handleAfterTransaction);
    this.pendingUpdates = [];
    this.outbox = [];
    this.bufferedMessages = [];
    this.actor.send({ type: "LEAVE" });
    this.actor.stop();
  }

  async retryNow(): Promise<void> {
    if (this.isStopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
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
    if (session.room.transport === "cloudflare-websocket") {
      const socket = this.socket;
      if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
        throw websocketRequestError("Collaboration WebSocket is not connected");
      }
      socket.send(
        JSON.stringify(
          collaborationWebSocketClientMessageSchema.parse({
            type: "awareness.state",
            data: input,
          }),
        ),
      );
      return;
    }
    const response = await this.api.publishAwareness(this.roomId, input);
    this.onAwarenessEvent?.(response.event);
  }

  private readonly handleAfterTransaction = (transaction: Y.Transaction) => {
    this.onDocumentChange?.(this.doc, transaction);
  };

  private readonly handleDocumentUpdate = (update: Uint8Array, origin: unknown) => {
    if (
      origin === COLLABORATION_ORIGIN.remoteProvider ||
      origin === COLLABORATION_ORIGIN.workspaceProjection ||
      origin === COLLABORATION_ORIGIN.playback ||
      !this.canWrite
    ) {
      return;
    }
    this.pendingUpdates.push(update);
    this.actor.send({ type: "OFFLINE_CHANGES" });
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.movePendingUpdatesToOutbox();
      void this.flushOutbox();
    }, this.batchWindowMs);
  };

  private movePendingUpdatesToOutbox(): void {
    if (this.pendingUpdates.length === 0) return;
    const updates = this.pendingUpdates;
    this.pendingUpdates = [];

    let batch: Uint8Array[] = [];
    const enqueueBatch = () => {
      if (batch.length === 0) return;
      this.outbox.push({
        input: createCollaborationDocumentUpdate(Y.mergeUpdates(batch), this.clientId),
      });
      batch = [];
    };
    for (const update of updates) {
      if (update.byteLength > MAX_YJS_UPDATE_BYTES) {
        this.fatal(
          `A local collaboration change exceeded the ${MAX_YJS_UPDATE_BYTES}-byte update limit`,
        );
        return;
      }
      const candidate = Y.mergeUpdates([...batch, update]);
      if (candidate.byteLength > MAX_YJS_UPDATE_BYTES) enqueueBatch();
      batch.push(update);
    }
    enqueueBatch();
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
      this.roomSession = roomSession;
      if (roomSession.room.roleVersion >= this.pendingControlRoleVersion) {
        this.pendingControlRoleVersion = 0;
      }
      if (roomSession.room.transport === "cloudflare-websocket") {
        this.openSocket(attemptId);
      } else {
        this.openSource(attemptId, roomSession.channel);
      }
    } catch (error) {
      if (this.isStopped || attemptId !== this.attemptId) return;
      if (isFatalRequestError(error)) {
        this.fatal(errorMessage(error, "This collaboration room is unavailable"), attemptId);
      } else {
        this.handleTransportFailure(
          errorMessage(error, "The collaboration room could not be reached"),
          attemptId,
        );
      }
    }
  }

  private openSource(attemptId: string, channel: string): void {
    this.closeTransport();
    this.bufferedMessages = [];
    const url = new URL("/api/collaboration/realtime", window.location.origin);
    const channels = [
      channel,
      collaborationAwarenessChannel(this.roomId),
      collaborationControlChannel(this.roomId),
    ];
    for (const currentChannel of channels) {
      url.searchParams.append("channel", currentChannel);
      const defaultCursor = currentChannel === channel ? String(Date.now()) : "0-0";
      url.searchParams.set(
        `last_ack_${currentChannel}`,
        this.lastAcknowledgedStreamIds.get(currentChannel) ?? defaultCursor,
      );
    }
    const source = this.eventSourceFactory(url.toString());
    this.source = source;
    source.onopen = () => {
      if (this.isStopped || attemptId !== this.attemptId || source !== this.source) return;
      this.actor.send({ type: "PROVIDER_OPEN", sessionId: this.sessionId, attemptId });
      void this.synchronize(attemptId);
    };
    source.onmessage = (event) => {
      if (this.isStopped || attemptId !== this.attemptId || source !== this.source) return;
      this.handleRealtimeMessage(event.data, attemptId);
    };
    source.onerror = () => {
      if (this.isStopped || attemptId !== this.attemptId || source !== this.source) return;
      this.handleTransportFailure("Realtime connection interrupted", attemptId);
    };
  }

  private openSocket(attemptId: string): void {
    this.closeTransport();
    this.bufferedMessages = [];
    const url = new URL(
      `/api/collaboration/rooms/${encodeURIComponent(this.roomId)}/websocket`,
      window.location.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("sessionId", this.sessionId);
    url.searchParams.set("attemptId", attemptId);
    const socket = this.webSocketFactory(url.toString());
    this.socket = socket;
    socket.onopen = () => {
      if (this.isStopped || attemptId !== this.attemptId || socket !== this.socket) return;
      this.actor.send({ type: "PROVIDER_OPEN", sessionId: this.sessionId, attemptId });
      this.heartbeatTimer = setInterval(() => {
        if (socket === this.socket && socket.readyState === WEBSOCKET_OPEN) socket.send("ping");
      }, WEBSOCKET_HEARTBEAT_MS);
      void this.synchronize(attemptId);
    };
    socket.onmessage = (event) => {
      if (this.isStopped || attemptId !== this.attemptId || socket !== this.socket) return;
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
    if (message.type === "session.ready") {
      if (message.sessionId !== this.sessionId || message.attemptId !== attemptId) return;
      for (const event of message.participants) this.onAwarenessEvent?.(event);
      return;
    }
    if (message.type === "document.ack") {
      const pending = this.pendingWebSocketAcks.get(message.updateId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingWebSocketAcks.delete(message.updateId);
      pending.resolve({
        accepted: true,
        updateId: message.updateId,
        streamId: message.streamId,
      });
      return;
    }
    if (message.type === "document.update") {
      const realtimeMessage: RealtimeUserMessage = {
        id: message.streamId,
        event: "document.update",
        channel: collaborationRoomChannel(this.roomId),
        data: message.data,
      };
      if (this.isSynchronizing || this.connectionState === "syncing") {
        this.bufferedMessages.push(realtimeMessage);
      } else {
        this.applyRealtimeMessage(realtimeMessage);
      }
      return;
    }
    if (message.type === "awareness.state") {
      this.onAwarenessEvent?.(message.data);
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

  private handleWebSocketError(
    message: Extract<CollaborationWebSocketServerMessage, { type: "error" }>,
    attemptId: string,
  ): void {
    const status =
      message.code === "read-only" || message.code === "access-revoked"
        ? 403
        : message.code === "rate-limited"
          ? 429
          : message.code === "invalid-message" || message.code === "invalid-session"
            ? 400
            : 503;
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

  private handleRealtimeMessage(raw: string, attemptId: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (typeof value === "object" && value !== null && "type" in value) {
      const type = (value as { type?: unknown }).type;
      if (type === "reconnect") {
        this.handleTransportFailure("Realtime connection is rotating", attemptId);
      } else if (type === "error") {
        this.handleTransportFailure("Realtime provider reported an error", attemptId);
      }
      return;
    }

    const message = parseRealtimeUserMessage(value);
    if (!message || !this.isRoomChannel(message.channel)) return;
    if (
      message.channel === collaborationRoomChannel(this.roomId) &&
      (this.isSynchronizing || this.connectionState === "syncing")
    ) {
      this.bufferedMessages.push(message);
      return;
    }
    this.applyRealtimeMessage(message);
  }

  private applyRealtimeMessage(message: RealtimeUserMessage): void {
    const seenKey = `${message.channel}|${message.id}`;
    if (this.seenStreamIds.has(seenKey)) return;
    if (message.event === "document.update") {
      const event = collaborationDocumentUpdateEventSchema.safeParse(message.data);
      if (!event.success || event.data.roomId !== this.roomId) return;
      applyEncodedYjsUpdate(this.doc, event.data.update, COLLABORATION_ORIGIN.remoteProvider);
    } else if (message.event === "awareness.state") {
      const event = collaborationAwarenessEventSchema.safeParse(message.data);
      if (!event.success || event.data.roomId !== this.roomId) return;
      this.onAwarenessEvent?.(event.data);
    } else if (message.event === "control.room") {
      const event = collaborationControlEventSchema.safeParse(message.data);
      if (!event.success || event.data.roomId !== this.roomId) return;
      this.onControlEvent?.(event.data);
      if (event.data.kind === "room-closed") {
        this.markStreamIdSeen(message.channel, message.id);
        this.fatal("The host ended this live collaboration room");
        return;
      }
      void this.refreshRoomFromControl(event.data);
    } else {
      return;
    }
    this.markStreamIdSeen(message.channel, message.id);
  }

  private isRoomChannel(channel: string): boolean {
    return (
      channel === collaborationRoomChannel(this.roomId) ||
      channel === collaborationAwarenessChannel(this.roomId) ||
      channel === collaborationControlChannel(this.roomId)
    );
  }

  private markStreamIdSeen(channel: string, streamId: string): void {
    this.seenStreamIds.add(`${channel}|${streamId}`);
    const lastAcknowledgedStreamId = this.lastAcknowledgedStreamIds.get(channel);
    if (!lastAcknowledgedStreamId || compareStreamIds(streamId, lastAcknowledgedStreamId) > 0) {
      this.lastAcknowledgedStreamIds.set(channel, streamId);
    }
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
        const previousCanWrite = this.canWrite;
        const roomSession = await this.api.getRoom(this.roomId);
        if (this.isStopped) return;
        if (roomSession.room.status !== "active") {
          this.fatal("The host ended this live collaboration room");
          return;
        }
        this.roomSession = roomSession;
        this.actor.send({
          type: "ROLE_CHANGED",
          role: roomSession.membership.role,
          roleVersion: roomSession.room.roleVersion,
        });
        if (previousCanWrite && !this.canWrite && this.hasPendingUpdates) {
          this.pendingUpdates = [];
          this.outbox = [];
          const message =
            "Your role changed before local edits were accepted. Copy any local work before rejoining.";
          this.onRejectedLocalChanges?.(message);
          this.fatal(message);
          return;
        }
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
        this.fatal(errorMessage(error, "You no longer have access to this collaboration room"));
      } else {
        this.handleTransportFailure(
          errorMessage(error, "Room permissions could not be refreshed"),
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

  private async synchronize(attemptId: string): Promise<void> {
    if (this.isSynchronizing) return;
    this.isSynchronizing = true;
    try {
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < MAX_BOOTSTRAP_PAGES; pageIndex += 1) {
        const bootstrap = await this.api.getBootstrap(this.roomId, cursor);
        if (this.isStopped || attemptId !== this.attemptId) return;
        if (
          bootstrap.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
          bootstrap.documentSchemaVersion !== COLLABORATION_DOCUMENT_SCHEMA_VERSION
        ) {
          this.fatal("This room snapshot uses an unsupported schema", attemptId);
          return;
        }
        if (pageIndex === 0) {
          applyEncodedYjsSnapshot(
            this.doc,
            bootstrap.snapshot.update,
            COLLABORATION_ORIGIN.remoteProvider,
          );
        }
        for (const update of bootstrap.updates) {
          const documentChannel = collaborationRoomChannel(this.roomId);
          if (!this.seenStreamIds.has(`${documentChannel}|${update.streamId}`)) {
            applyEncodedYjsUpdate(
              this.doc,
              update.event.update,
              COLLABORATION_ORIGIN.remoteProvider,
            );
            this.markStreamIdSeen(documentChannel, update.streamId);
          }
        }
        if (!bootstrap.hasMore) break;
        if (bootstrap.nextCursor === cursor) {
          throw new Error("Collaboration bootstrap cursor did not advance");
        }
        cursor = bootstrap.nextCursor;
        if (pageIndex === MAX_BOOTSTRAP_PAGES - 1) {
          throw new Error("Collaboration bootstrap page limit exceeded");
        }
      }

      const buffered = this.bufferedMessages;
      this.bufferedMessages = [];
      for (const message of buffered) this.applyRealtimeMessage(message);
      if (!this.roomSession) throw new Error("Collaboration room session is missing");
      this.actor.send({
        type: "SYNCED",
        sessionId: this.sessionId,
        attemptId,
        roomSession: this.roomSession,
      });
      this.reconnectAttempt = 0;
      // Once the machine is live, atomically stop buffering and drain the
      // small tail that could have arrived while the first buffer was applied.
      const finalBuffered = this.bufferedMessages;
      this.bufferedMessages = [];
      this.isSynchronizing = false;
      for (const message of finalBuffered) this.applyRealtimeMessage(message);
      await this.flushOutbox();
    } catch (error) {
      if (this.isStopped || attemptId !== this.attemptId) return;
      if (isFatalRequestError(error)) {
        this.fatal(errorMessage(error, "Collaboration synchronization was rejected"), attemptId);
      } else {
        this.handleTransportFailure(
          errorMessage(error, "Collaboration synchronization failed"),
          attemptId,
        );
      }
    } finally {
      this.isSynchronizing = false;
    }
  }

  private async flushOutbox(): Promise<void> {
    if (this.isPublishing || this.connectionState !== "live" || !this.canWrite) return;
    this.isPublishing = true;
    try {
      while (!this.isStopped && this.connectionState === "live" && this.outbox.length > 0) {
        const pending = this.outbox[0];
        try {
          const accepted = await this.publishTransportUpdate(pending.input);
          if (!accepted.accepted || accepted.updateId !== pending.input.updateId) {
            throw new Error("Collaboration update acknowledgement did not match the request");
          }
          this.outbox.shift();
        } catch (error) {
          if (errorStatus(error) === 403) {
            await this.handleWriteRejection(error);
          } else if (isFatalRequestError(error)) {
            this.fatal(errorMessage(error, "A collaboration update was rejected"));
          } else {
            this.handleTransportFailure(
              errorMessage(error, "A collaboration update could not be delivered"),
              this.attemptId,
            );
          }
          return;
        }
      }
      if (!this.hasPendingUpdates) this.actor.send({ type: "CHANGES_FLUSHED" });
    } finally {
      this.isPublishing = false;
      if (
        !this.isStopped &&
        this.connectionState === "live" &&
        this.outbox.length > 0 &&
        this.canWrite
      ) {
        void this.flushOutbox();
      } else if (this.pendingUpdates.length === 0 && this.outbox.length === 0) {
        this.actor.send({ type: "CHANGES_FLUSHED" });
      }
    }
  }

  private publishTransportUpdate(
    input: CollaborationDocumentUpdateInput,
  ): Promise<CollaborationUpdateAccepted> {
    if (this.roomSession?.room.transport !== "cloudflare-websocket") {
      return this.api.publishUpdate(this.roomId, input);
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
      return Promise.reject(websocketRequestError("Collaboration WebSocket is not connected"));
    }
    return new Promise<CollaborationUpdateAccepted>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWebSocketAcks.delete(input.updateId);
        reject(websocketRequestError("Collaboration update acknowledgement timed out"));
      }, WEBSOCKET_ACK_TIMEOUT_MS);
      this.pendingWebSocketAcks.set(input.updateId, { resolve, reject, timer });
      try {
        socket.send(
          JSON.stringify(
            collaborationWebSocketClientMessageSchema.parse({
              type: "document.update",
              data: input,
            }),
          ),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pendingWebSocketAcks.delete(input.updateId);
        reject(error instanceof Error ? error : websocketRequestError("WebSocket send failed"));
      }
    });
  }

  private async handleWriteRejection(error: unknown): Promise<void> {
    try {
      const roomSession = await this.api.getRoom(this.roomId);
      this.roomSession = roomSession;
      this.actor.send({
        type: "ROLE_CHANGED",
        role: roomSession.membership.role,
        roleVersion: roomSession.room.roleVersion,
      });
    } catch {
      // The original permission response remains the actionable failure.
    }
    this.outbox = [];
    const message =
      "Your role changed before offline edits were accepted. Copy any local work before rejoining.";
    this.onRejectedLocalChanges?.(message);
    this.fatal(errorMessage(error, message));
  }

  private handleTransportFailure(message: string, attemptId: string): void {
    if (this.isStopped || attemptId !== this.attemptId) return;
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
      attempt: this.reconnectAttempt,
    });
    await this.connectAttempt(this.attemptId);
  }

  private fatal(message: string, attemptId = this.attemptId): void {
    if (this.isStopped || attemptId !== this.attemptId) return;
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

  private closeSource(): void {
    const source = this.source;
    this.source = null;
    if (!source) return;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    source.close();
  }

  private closeSocket(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const socket = this.socket;
    this.socket = null;
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

  private closeTransport(): void {
    this.closeSource();
    this.closeSocket();
  }
}
