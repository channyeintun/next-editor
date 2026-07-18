import { createActor, type Actor } from "xstate";
import {
  VOICE_CAPABILITY_HEADER,
  type VoiceLimits,
  type VoiceParticipant,
  type VoicePublishedTrack,
  type VoiceServerMessage,
} from "../collaboration/voiceProtocol";
import {
  buildVoiceSfuExtraParams,
  buildVoiceSfuPrefix,
  buildVoiceWebSocketUrl,
  connectVoiceCoordination,
  type VoiceCoordinationConnection,
  type VoiceSocketFactory,
} from "./client";
import { voiceMachine, type VoiceClientErrorCode, type VoiceUnavailableReason } from "./machine";
import type {
  VoiceMediaSession,
  VoiceMediaSessionConfig,
  VoiceRemoteSubscription,
} from "./partyTracksAdapter";
import type { RemoteAudioSink } from "./remoteAudioSink";
import type { SpeakingDetectorHandle } from "./speakingDetector";
import type { VoiceRosterEntry, VoiceUiState } from "./types";

const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 8_000;

export interface VoiceEngineOptions {
  roomId: string;
  collaborationSessionId: string;
}

// Every effectful dependency is injectable so lifecycle invariants are
// testable without WebSocket/WebRTC/Audio APIs.
export interface VoiceEngineDeps {
  createSocket: VoiceSocketFactory;
  createMediaSession: (config: VoiceMediaSessionConfig) => VoiceMediaSession;
  createSink: (onBlockedChange: (blocked: boolean) => void) => RemoteAudioSink;
  createSpeakingDetector: (
    track: MediaStreamTrack,
    onChange: (isSpeaking: boolean) => void,
  ) => SpeakingDetectorHandle;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

interface RemoteEntry {
  trackKey: string;
  subscription: VoiceRemoteSubscription;
  sink: RemoteAudioSink;
  detector: SpeakingDetectorHandle | null;
}

function mapMicrophoneError(error: unknown): VoiceClientErrorCode {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "microphone-permission-denied";
  }
  if (name === "NotFoundError" || name === "NotReadableError" || name === "OverconstrainedError") {
    return "microphone-unavailable";
  }
  return "network";
}

function toRtcIceServers(limits: VoiceLimits): RTCIceServer[] {
  return limits.iceServers.map((server) => ({ ...server }));
}

export class VoiceEngine {
  private readonly actor: Actor<typeof voiceMachine>;
  private readonly options: VoiceEngineOptions;
  private readonly deps: VoiceEngineDeps;

  private connection: VoiceCoordinationConnection | null = null;
  private media: VoiceMediaSession | null = null;
  private voiceConnectionId: string | null = null;
  private generationReady = false;
  private lastMicTrack: MediaStreamTrack | null = null;

  private roster = new Map<string, VoiceParticipant>();
  private roomRevision = 0;
  private readonly remotes = new Map<string, RemoteEntry>();
  private localDetector: SpeakingDetectorHandle | null = null;
  private readonly speaking = new Map<string, boolean>();
  private localSpeaking = false;

  private muteRevision = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cleaningUp = false;
  private disposed = false;

  private readonly listeners = new Set<() => void>();
  private uiState: VoiceUiState;

  constructor(options: VoiceEngineOptions, deps: VoiceEngineDeps) {
    this.options = options;
    this.deps = deps;
    this.actor = createActor(voiceMachine);
    this.uiState = this.buildUiState();
    this.actor.subscribe(() => {
      const snapshot = this.actor.getSnapshot();
      if (snapshot.value === "leaving" && !this.cleaningUp) {
        this.cleaningUp = true;
        this.performCleanup();
        this.actor.send({ type: "CLEANUP_DONE" });
        this.cleaningUp = false;
      }
      // Failed keeps the error visible but must not keep media resources.
      if (snapshot.value === "failed" && !this.cleaningUp) {
        this.cleaningUp = true;
        this.performCleanup();
        this.cleaningUp = false;
      }
      this.notify();
    });
    this.actor.start();
  }

  // --- public surface -----------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getUiState(): VoiceUiState {
    return this.uiState;
  }

  setAvailability(reason: VoiceUnavailableReason | null): void {
    if (reason === null) this.actor.send({ type: "SET_AVAILABLE" });
    else this.actor.send({ type: "SET_UNAVAILABLE", reason });
  }

  join(): void {
    this.actor.send({ type: "JOIN", roomId: this.options.roomId });
    if (this.actor.getSnapshot().value !== "joining") return;
    this.muteRevision = 0;
    this.openGeneration();
  }

  leave(): void {
    this.actor.send({ type: "LEAVE" });
  }

  retry(): void {
    this.actor.send({ type: "RETRY" });
    if (this.actor.getSnapshot().value !== "joining") return;
    this.muteRevision = 0;
    this.openGeneration();
  }

  unmute(): void {
    this.actor.send({ type: "UNMUTE" });
    if (this.actor.getSnapshot().value !== "unmuting") return;
    const media = this.media;
    if (!media) {
      this.actor.send({ type: "UNMUTE_FAILED", code: "network" });
      return;
    }
    void media.publishMicrophone().then(
      () => {
        const state = this.actor.getSnapshot().value;
        if (state !== "unmuting" && state !== "reconnecting") {
          // The user muted or left while the publish was in flight; release
          // the capture rather than going live silently.
          media.muteAndReleaseMicrophone();
          return;
        }
        this.actor.send({ type: "PUBLISHED" });
        this.sendMuteChanged(false);
        this.refreshLocalDetector();
      },
      (error: unknown) => {
        media.muteAndReleaseMicrophone();
        this.actor.send({ type: "UNMUTE_FAILED", code: mapMicrophoneError(error) });
      },
    );
  }

  mute(): void {
    const before = this.actor.getSnapshot().value;
    this.actor.send({ type: "MUTE" });
    if (before !== "live" && before !== "unmuting" && before !== "reconnecting") return;
    this.media?.muteAndReleaseMicrophone();
    this.stopLocalDetector();
    this.sendMuteChanged(true);
  }

  enableAudio(): void {
    for (const entry of this.remotes.values()) entry.sink.retryPlayback();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.leave();
    // If the machine was already idle/unavailable the leaving path did not
    // run; cleanup is idempotent.
    this.performCleanup();
    this.actor.stop();
    this.listeners.clear();
  }

  // --- coordination socket ------------------------------------------------

  private openGeneration(): void {
    this.generationReady = false;
    const url = buildVoiceWebSocketUrl(this.options.roomId, this.options.collaborationSessionId);
    const connection = connectVoiceCoordination(this.deps.createSocket, url, {
      onOpen: () => undefined,
      onMessage: (message) => {
        if (this.connection === connection) this.handleServerMessage(message);
      },
      onClose: () => {
        if (this.connection === connection) this.handleConnectionLost();
      },
    });
    this.connection = connection;
  }

  private handleServerMessage(message: VoiceServerMessage): void {
    switch (message.type) {
      case "voice.ready": {
        this.voiceConnectionId = message.voiceConnectionId;
        // A new generation means a new capability: the previous media
        // session's gateway access is gone, so it is fully replaced.
        this.teardownMedia();
        const media = this.deps.createMediaSession({
          prefix: buildVoiceSfuPrefix(this.options.roomId),
          apiExtraParams: buildVoiceSfuExtraParams(
            message.voiceConnectionId,
            this.options.collaborationSessionId,
          ),
          capability: message.capability,
          capabilityHeaderName: VOICE_CAPABILITY_HEADER,
          iceServers: toRtcIceServers(message.limits),
        });
        this.media = media;
        // One listener per media session; repeated mute/unmute cycles must
        // not stack subscriptions.
        media.onMicrophoneTrack((track) => {
          this.lastMicTrack = track;
          this.refreshLocalDetector();
        });
        media.onMicrophoneError(() => {
          if (this.media !== media) return;
          const state = this.actor.getSnapshot().value;
          if (state !== "live") return;
          media.muteAndReleaseMicrophone();
          this.actor.send({ type: "UNMUTE_FAILED", code: "microphone-unavailable" });
          this.sendMuteChanged(true);
        });
        return;
      }
      case "voice.snapshot": {
        this.roomRevision = message.revision;
        this.applyRoster(message.participants);
        if (!this.generationReady) {
          this.generationReady = true;
          this.reconnectAttempt = 0;
          this.finishGenerationStart();
        }
        return;
      }
      case "voice.participant-upsert": {
        if (message.revision <= this.roomRevision) return;
        this.roomRevision = message.revision;
        const participants = new Map(this.roster);
        participants.set(message.participant.voiceConnectionId, message.participant);
        this.applyRoster([...participants.values()]);
        return;
      }
      case "voice.participant-left": {
        if (message.revision <= this.roomRevision) return;
        this.roomRevision = message.revision;
        const participants = new Map(this.roster);
        participants.delete(message.voiceConnectionId);
        this.applyRoster([...participants.values()]);
        return;
      }
      case "voice.room-closed": {
        // Terminal for voice; the collaboration context reflects the room
        // state through its own channel.
        this.leave();
        return;
      }
      case "voice.error": {
        if (!message.recoverable) this.actor.send({ type: "FAIL", code: message.code });
        return;
      }
      case "voice.pong":
        return;
    }
  }

  private finishGenerationStart(): void {
    const state = this.actor.getSnapshot().value;
    if (state === "joining") {
      this.actor.send({ type: "READY" });
      return;
    }
    if (state !== "reconnecting") return;
    const wantsMicrophone = this.actor.getSnapshot().context.wantsMicrophone;
    const media = this.media;
    if (!wantsMicrophone || !media) {
      this.actor.send({ type: "TRANSPORT_RECOVERED", publishing: false });
      return;
    }
    // Restore the user's unmuted intent on the new generation; permission
    // was already granted, so no prompt appears.
    void media.publishMicrophone().then(
      () => {
        if (this.actor.getSnapshot().value !== "reconnecting") {
          media.muteAndReleaseMicrophone();
          return;
        }
        this.actor.send({ type: "TRANSPORT_RECOVERED", publishing: true });
        this.sendMuteChanged(false);
        this.refreshLocalDetector();
      },
      () => {
        media.muteAndReleaseMicrophone();
        this.actor.send({ type: "TRANSPORT_RECOVERED", publishing: false });
        this.sendMuteChanged(true);
      },
    );
  }

  private handleConnectionLost(): void {
    this.connection = null;
    const state = this.actor.getSnapshot().value;
    if (state === "idle" || state === "leaving" || state === "unavailable" || state === "failed") {
      return;
    }
    this.actor.send({ type: "TRANSPORT_LOST" });
    if (this.actor.getSnapshot().value !== "reconnecting") return;
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.actor.send({ type: "FAIL", code: "network" });
      return;
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.deps.setTimer(() => {
      this.reconnectTimer = null;
      if (this.actor.getSnapshot().value === "reconnecting") this.openGeneration();
    }, delay);
  }

  private sendMuteChanged(muted: boolean): void {
    this.muteRevision = Math.min(this.muteRevision + 1, Number.MAX_SAFE_INTEGER);
    this.connection?.sendMuteChanged(this.muteRevision, muted);
  }

  // --- media & roster -----------------------------------------------------

  // Recreates the local speaking detector against the newest microphone
  // track. Only active while live: when muted the source is released, so no
  // "speaking while muted" analysis can exist (plan §8.5).
  private refreshLocalDetector(): void {
    this.stopLocalDetector();
    const track = this.lastMicTrack;
    if (!track || this.actor.getSnapshot().value !== "live") return;
    this.localDetector = this.deps.createSpeakingDetector(track, (isSpeaking) => {
      if (this.localSpeaking === isSpeaking) return;
      this.localSpeaking = isSpeaking;
      this.notify();
    });
  }

  private stopLocalDetector(): void {
    this.localDetector?.stop();
    this.localDetector = null;
    if (this.localSpeaking) {
      this.localSpeaking = false;
      this.notify();
    }
  }

  private applyRoster(participants: VoiceParticipant[]): void {
    this.roster = new Map(participants.map((entry) => [entry.voiceConnectionId, entry]));
    const media = this.media;
    const wanted = new Map<string, VoicePublishedTrack>();
    for (const participant of participants) {
      if (
        participant.voiceConnectionId !== this.voiceConnectionId &&
        participant.publishedTrack !== null
      ) {
        wanted.set(participant.voiceConnectionId, participant.publishedTrack);
      }
    }
    for (const [connectionId, entry] of this.remotes) {
      const track = wanted.get(connectionId);
      const trackKey = track ? `${track.sessionId}/${track.trackName}` : null;
      if (trackKey === null || trackKey !== entry.trackKey) {
        this.removeRemote(connectionId);
      }
    }
    if (media) {
      for (const [connectionId, track] of wanted) {
        if (!this.remotes.has(connectionId)) {
          this.addRemote(media, connectionId, track);
        }
      }
    }
    this.notify();
  }

  private addRemote(
    media: VoiceMediaSession,
    connectionId: string,
    track: VoicePublishedTrack,
  ): void {
    const sink = this.deps.createSink(() => this.notify());
    const subscription = media.pullTrack(track);
    const entry: RemoteEntry = {
      trackKey: `${track.sessionId}/${track.trackName}`,
      subscription,
      sink,
      detector: null,
    };
    subscription.onTrack((mediaTrack) => {
      sink.setTrack(mediaTrack);
      entry.detector?.stop();
      entry.detector = this.deps.createSpeakingDetector(mediaTrack, (isSpeaking) => {
        if (this.speaking.get(connectionId) === isSpeaking) return;
        this.speaking.set(connectionId, isSpeaking);
        this.notify();
      });
    });
    this.remotes.set(connectionId, entry);
  }

  private removeRemote(connectionId: string): void {
    const entry = this.remotes.get(connectionId);
    if (!entry) return;
    entry.detector?.stop();
    entry.subscription.close();
    entry.sink.cleanup();
    this.remotes.delete(connectionId);
    this.speaking.delete(connectionId);
  }

  private teardownMedia(): void {
    this.stopLocalDetector();
    for (const connectionId of this.remotes.keys()) this.removeRemote(connectionId);
    this.media?.close();
    this.media = null;
    this.lastMicTrack = null;
  }

  private performCleanup(): void {
    if (this.reconnectTimer !== null) {
      this.deps.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      connection.sendLeave();
      connection.close();
    }
    this.teardownMedia();
    this.roster = new Map();
    this.speaking.clear();
    this.localSpeaking = false;
    this.voiceConnectionId = null;
    this.generationReady = false;
    this.reconnectAttempt = 0;
    this.notify();
  }

  // --- UI state -----------------------------------------------------------

  private buildUiState(): VoiceUiState {
    const snapshot = this.actor?.getSnapshot();
    const roster: VoiceRosterEntry[] = [...this.roster.values()].map((participant) => ({
      participant,
      isSelf: participant.voiceConnectionId === this.voiceConnectionId,
      isSpeaking: this.speaking.get(participant.voiceConnectionId) ?? false,
    }));
    let autoplayBlocked = false;
    for (const entry of this.remotes.values()) {
      if (entry.sink.isBlocked()) autoplayBlocked = true;
    }
    return {
      state: (snapshot?.value as VoiceUiState["state"]) ?? "unavailable",
      unavailableReason: snapshot?.context.unavailableReason ?? null,
      errorCode: snapshot?.context.errorCode ?? null,
      autoplayBlocked,
      roster,
      isLocalSpeaking: this.localSpeaking,
    };
  }

  private notify(): void {
    this.uiState = this.buildUiState();
    for (const listener of this.listeners) listener();
  }
}
