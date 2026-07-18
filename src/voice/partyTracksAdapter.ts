import { PartyTracks, createAudioSink, getMic } from "partytracks/client";
import type { MediaDevice, SinkApi, TrackMetadata } from "partytracks/client";
import {
  BehaviorSubject,
  type Observable,
  Subject,
  Subscription,
  combineLatest,
  firstValueFrom,
  race,
  throwError,
} from "rxjs";
import { filter, map, retry, shareReplay, switchMap, take, timeout } from "rxjs/operators";
import type { VoicePublishedTrack } from "../collaboration/voiceProtocol";

// The only module allowed to import partytracks (pinned exactly at 0.0.56).
// Everything else consumes VoiceMediaSession so the pre-1.0 dependency stays
// replaceable (plan §13.2).

const PUBLISH_TIMEOUT_MS = 15_000;

export interface VoiceMediaSessionConfig {
  // Room-scoped, same-origin gateway prefix, e.g.
  // /api/collaboration/rooms/<roomId>/voice/sfu
  prefix: string;
  // voiceConnectionId + collaborationSessionId, appended to every API call.
  apiExtraParams: string;
  // Carries the in-memory capability; never persisted.
  capability: string;
  capabilityHeaderName: string;
  iceServers: RTCIceServer[];
}

export interface VoiceRemoteSubscription {
  onTrack: (listener: (track: MediaStreamTrack) => void) => void;
  close: () => void;
}

export interface VoiceAudioSinkHandle {
  attach: (subscription: VoiceRemoteSubscription) => void;
  element: HTMLAudioElement;
  cleanup: () => void;
}

export interface VoiceMediaSession {
  // Lazily acquires the microphone and publishes one audio track. Resolves
  // with the published track metadata; rejects on permission/device failure.
  publishMicrophone: () => Promise<VoicePublishedTrack>;
  // Releases the physical capture (source disabled, underlying track
  // stopped) while keeping the negotiated publication fed by silence.
  muteAndReleaseMicrophone: () => void;
  // Re-enables capture after a mute; requires publishMicrophone() to have
  // succeeded once. May transparently reacquire the device.
  resumeBroadcasting: () => void;
  onMicrophoneTrack: (listener: (track: MediaStreamTrack | null) => void) => void;
  // Device failures after a successful publish (unplugged, revoked).
  onMicrophoneError: (listener: (error: Error) => void) => void;
  pullTrack: (track: VoicePublishedTrack) => VoiceRemoteSubscription;
  createSink: (audioElement: HTMLAudioElement) => SinkApi;
  onConnectionState: (listener: (state: RTCPeerConnectionState) => void) => void;
  close: () => void;
}

// Initial microphone constraints from plan §8.2; the browser and Opus
// negotiate the sample rate.
const MICROPHONE_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: { ideal: 1 },
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
};

export function createVoiceMediaSession(config: VoiceMediaSessionConfig): VoiceMediaSession {
  const subscriptions = new Subscription();
  const headers = new Headers({
    [config.capabilityHeaderName]: config.capability,
    "Content-Type": "application/json",
  });
  const partyTracks = new PartyTracks({
    prefix: config.prefix,
    apiExtraParams: config.apiExtraParams,
    headers,
    iceServers: config.iceServers,
    maxApiHistory: 0,
  });
  // PartyTracks clamps maxApiHistory to at least one entry. Disable the
  // public logger explicitly so SDP and SFU identifiers are not retained in
  // its in-memory debugging history.
  partyTracks.history.entries.length = 0;
  partyTracks.history.log = () => undefined;

  let mic: MediaDevice | null = null;
  let microphoneBroadcastTrack$: Observable<MediaStreamTrack> | null = null;
  let microphoneRetry$: Subject<void> | null = null;
  let publishedMetadata$: BehaviorSubject<TrackMetadata | null> | null = null;
  const micTrackListeners = new Set<(track: MediaStreamTrack | null) => void>();
  const micErrorListeners = new Set<(error: Error) => void>();
  let closed = false;

  const ensureMicrophone = (): MediaDevice => {
    if (mic) return mic;
    // broadcasting/activateSource/retainIdleTrack all false: no capture until
    // resumeBroadcasting(), and a mute stops the physical device (verified
    // against the pinned build; plan §8.3).
    mic = getMic({
      broadcasting: false,
      activateSource: false,
      retainIdleTrack: false,
      constraints: MICROPHONE_CONSTRAINTS,
    });
    microphoneRetry$ = new Subject<void>();
    // A capture denial/device failure terminates PartyTracks' source
    // observable. Hold the publication open and retry that same source only
    // after the user explicitly tries Unmute again. This preserves the
    // stable SFU track name and makes the visible Retry action functional.
    microphoneBroadcastTrack$ = mic.broadcastTrack$.pipe(
      retry({ delay: () => (microphoneRetry$ as Subject<void>).pipe(take(1)) }),
      shareReplay({ refCount: true, bufferSize: 1 }),
    );
    subscriptions.add(
      microphoneBroadcastTrack$.subscribe({
        next: (track) => {
          for (const listener of micTrackListeners) listener(track);
        },
      }),
    );
    subscriptions.add(
      mic.error$.subscribe({
        next: (error) => {
          for (const listener of micErrorListeners) listener(error);
        },
      }),
    );
    return mic;
  };

  return {
    async publishMicrophone() {
      if (closed) throw new Error("voice media session is closed");
      const device = ensureMicrophone();
      if (!publishedMetadata$) {
        const metadata$ = new BehaviorSubject<TrackMetadata | null>(null);
        publishedMetadata$ = metadata$;
        subscriptions.add(
          partyTracks.push(microphoneBroadcastTrack$ as Observable<MediaStreamTrack>).subscribe({
            next: (metadata) => metadata$.next(metadata),
            error: () => metadata$.next(null),
          }),
        );
      }
      const publicationReady$ = combineLatest([
        publishedMetadata$.pipe(
          filter(
            (metadata): metadata is TrackMetadata =>
              metadata !== null &&
              typeof metadata.trackName === "string" &&
              typeof metadata.sessionId === "string",
          ),
        ),
        device.isBroadcasting$.pipe(filter((isBroadcasting) => isBroadcasting)),
      ]).pipe(map(([metadata]) => metadata));
      const captureFailed$ = device.error$.pipe(
        take(1),
        switchMap((error) => throwError(() => error)),
      );
      // If a prior capture attempt failed, release the retryable source from
      // its wait before re-enabling the physical device.
      microphoneRetry$?.next();
      device.startBroadcasting();
      const metadata = await firstValueFrom(
        race(publicationReady$, captureFailed$).pipe(timeout({ first: PUBLISH_TIMEOUT_MS })),
      );
      return {
        sessionId: metadata.sessionId as string,
        trackName: metadata.trackName as string,
        location: "remote",
      };
    },

    muteAndReleaseMicrophone() {
      // disableSource() also stops broadcasting and tears down the
      // underlying getUserMedia track; the publication continues as silence.
      mic?.disableSource();
    },

    resumeBroadcasting() {
      mic?.startBroadcasting();
    },

    onMicrophoneTrack(listener) {
      micTrackListeners.add(listener);
    },

    onMicrophoneError(listener) {
      micErrorListeners.add(listener);
    },

    pullTrack(track) {
      const trackListeners = new Set<(mediaTrack: MediaStreamTrack) => void>();
      const subscription = partyTracks
        .pull(
          new BehaviorSubject<TrackMetadata>({
            location: "remote",
            sessionId: track.sessionId,
            trackName: track.trackName,
          }),
        )
        .subscribe({
          next: (mediaTrack) => {
            for (const listener of trackListeners) listener(mediaTrack);
          },
          // Pull failures surface through sink/roster state, not exceptions.
          error: () => undefined,
        });
      subscriptions.add(subscription);
      return {
        onTrack(listener) {
          trackListeners.add(listener);
        },
        close() {
          trackListeners.clear();
          subscription.unsubscribe();
          subscriptions.remove(subscription);
        },
      };
    },

    createSink(audioElement) {
      return createAudioSink({ audioElement });
    },

    onConnectionState(listener) {
      subscriptions.add(
        partyTracks.peerConnectionState$.subscribe({ next: listener, error: () => undefined }),
      );
    },

    close() {
      if (closed) return;
      closed = true;
      micTrackListeners.clear();
      micErrorListeners.clear();
      mic?.disableSource();
      microphoneRetry$?.complete();
      microphoneRetry$ = null;
      microphoneBroadcastTrack$ = null;
      // Dropping every subscription releases partytracks' refCounted
      // peer connection, mic source, and pulled tracks.
      subscriptions.unsubscribe();
    },
  };
}
