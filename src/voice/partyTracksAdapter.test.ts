import { Observable, BehaviorSubject, Subject, type Subscriber } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceMediaSession } from "./partyTracksAdapter";

const partyMocks = vi.hoisted(() => ({
  createAudioSink: vi.fn<(...args: unknown[]) => unknown>(),
  getMic: vi.fn<() => unknown>(),
  pull: vi.fn<(...args: unknown[]) => Observable<never>>(),
  push: vi.fn<(source$: Observable<MediaStreamTrack>) => Observable<unknown>>(),
}));

vi.mock("partytracks/client", () => ({
  PartyTracks: class {
    history = { entries: [], log: vi.fn<(...args: unknown[]) => void>() };
    peerConnectionState$ = new Observable<never>();
    pull = partyMocks.pull;
    push = partyMocks.push;
  },
  createAudioSink: partyMocks.createAudioSink,
  getMic: partyMocks.getMic,
}));

function createMicrophoneHarness() {
  const error$ = new Subject<Error>();
  const isBroadcasting$ = new BehaviorSubject(false);
  const subscribers = new Set<Subscriber<MediaStreamTrack>>();
  let subscriptions = 0;
  const broadcastTrack$ = new Observable<MediaStreamTrack>((subscriber) => {
    subscriptions += 1;
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  });
  const device = {
    broadcastTrack$,
    disableSource: vi.fn<() => void>(),
    error$,
    isBroadcasting$,
    startBroadcasting: vi.fn<() => void>(),
  };
  partyMocks.getMic.mockReturnValue(device);
  partyMocks.push.mockImplementation(
    (source$: Observable<MediaStreamTrack>) =>
      new Observable((subscriber) =>
        source$.subscribe({
          complete: () => subscriber.complete(),
          error: (error) => subscriber.error(error),
          next: () =>
            subscriber.next({
              location: "remote",
              sessionId: "session-abc",
              trackName: "stable-microphone",
            }),
        }),
      ),
  );
  return {
    device,
    emit(track = {} as MediaStreamTrack) {
      for (const subscriber of subscribers) subscriber.next(track);
    },
    fail(error: Error) {
      error$.next(error);
      for (const subscriber of subscribers) subscriber.error(error);
    },
    subscriptionCount: () => subscriptions,
  };
}

function createSession() {
  return createVoiceMediaSession({
    apiExtraParams: "voiceConnectionId=connection",
    capability: "capability",
    capabilityHeaderName: "X-Voice-Capability",
    iceServers: [],
    prefix: "/voice/sfu",
  });
}

describe("PartyTracks microphone adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("waits for physical capture instead of resolving from the idle track", async () => {
    const microphone = createMicrophoneHarness();
    const session = createSession();
    let settled = false;
    const publishing = session.publishMicrophone().finally(() => {
      settled = true;
    });

    microphone.emit();
    await Promise.resolve();
    expect(settled).toBe(false);

    microphone.device.isBroadcasting$.next(true);
    await expect(publishing).resolves.toMatchObject({
      sessionId: "session-abc",
      trackName: "stable-microphone",
    });
    session.close();
  });

  it("retries capture without creating a second PartyTracks publication", async () => {
    const microphone = createMicrophoneHarness();
    const session = createSession();
    const denied = new DOMException("denied", "NotAllowedError");
    const firstAttempt = session.publishMicrophone();
    microphone.fail(denied);
    await expect(firstAttempt).rejects.toBe(denied);

    const secondAttempt = session.publishMicrophone();
    microphone.emit();
    microphone.device.isBroadcasting$.next(true);
    await expect(secondAttempt).resolves.toMatchObject({
      sessionId: "session-abc",
      trackName: "stable-microphone",
    });

    expect(partyMocks.push).toHaveBeenCalledTimes(1);
    expect(microphone.subscriptionCount()).toBe(2);
    session.close();
  });
});
