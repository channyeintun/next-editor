import {
  COLLABORATION_VOICE_PROTOCOL_VERSION,
  parseVoiceServerMessage,
  type VoiceClientMessage,
  type VoiceServerMessage,
} from "../collaboration/voiceProtocol";

// Thin room-scoped wrapper around the voice coordination WebSocket. The
// engine owns reconnect policy; each client instance is a single connection
// generation.

export interface VoiceSocketLike {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener: (
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number }) => void,
  ) => void;
  readyState: number;
}

export type VoiceSocketFactory = (url: string) => VoiceSocketLike;

export interface VoiceCoordinationHandlers {
  onOpen: () => void;
  onMessage: (message: VoiceServerMessage) => void;
  // Fired once per connection for both error and close.
  onClose: (event: { code: number | null }) => void;
}

export interface VoiceCoordinationConnection {
  send: (message: VoiceClientMessage) => void;
  sendMuteChanged: (revision: number, muted: boolean) => void;
  sendLeave: () => void;
  close: () => void;
}

export function buildVoiceWebSocketUrl(roomId: string, collaborationSessionId: string): string {
  const url = new URL(
    `/api/collaboration/rooms/${encodeURIComponent(roomId)}/voice/websocket`,
    window.location.origin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("collaborationSessionId", collaborationSessionId);
  return url.toString();
}

export function buildVoiceSfuPrefix(roomId: string): string {
  return `/api/collaboration/rooms/${encodeURIComponent(roomId)}/voice/sfu`;
}

export function buildVoiceSfuExtraParams(
  voiceConnectionId: string,
  collaborationSessionId: string,
): string {
  const params = new URLSearchParams({
    voiceConnectionId,
    collaborationSessionId,
  });
  return params.toString();
}

export function connectVoiceCoordination(
  createSocket: VoiceSocketFactory,
  url: string,
  handlers: VoiceCoordinationHandlers,
): VoiceCoordinationConnection {
  const socket = createSocket(url);
  let settled = false;
  const settleClose = (code: number | null) => {
    if (settled) return;
    settled = true;
    handlers.onClose({ code });
  };

  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = parseVoiceServerMessage(event.data);
    // Unknown or malformed server frames are dropped, never guessed at.
    if (message) handlers.onMessage(message);
  });
  socket.addEventListener("close", (event) => settleClose(event.code ?? null));
  socket.addEventListener("error", () => settleClose(null));

  const send = (message: VoiceClientMessage) => {
    if (socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A send race with close is not fatal; the close handler recovers.
    }
  };

  return {
    send,
    sendMuteChanged(revision, muted) {
      send({
        type: "voice.mute-changed",
        version: COLLABORATION_VOICE_PROTOCOL_VERSION,
        revision,
        muted,
      });
    },
    sendLeave() {
      send({ type: "voice.leave", version: COLLABORATION_VOICE_PROTOCOL_VERSION });
    },
    close() {
      settled = true;
      try {
        socket.close(1000, "left voice");
      } catch {
        // Already closed.
      }
    },
  };
}
