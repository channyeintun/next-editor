// Playback-only sink for one remote publication. These elements are never
// wired into the recorder's mix graph (plan §11): remote voice must not be
// captured by SCR3 recordings.

export interface RemoteAudioSink {
  setTrack: (track: MediaStreamTrack | null) => void;
  currentTrack: () => MediaStreamTrack | null;
  // True when the browser's autoplay policy rejected playback and an
  // explicit user gesture is required.
  isBlocked: () => boolean;
  retryPlayback: () => void;
  cleanup: () => void;
}

export interface RemoteAudioSinkOptions {
  onBlockedChange: (blocked: boolean) => void;
  // Injectable for tests.
  createElement?: () => HTMLAudioElement;
}

export function createRemoteAudioSink(options: RemoteAudioSinkOptions): RemoteAudioSink {
  const element = options.createElement ? options.createElement() : document.createElement("audio");
  element.autoplay = true;
  element.setAttribute("playsinline", "true");
  element.dataset["voiceSink"] = "true";
  element.style.display = "none";
  document.body.appendChild(element);

  let track: MediaStreamTrack | null = null;
  let blocked = false;

  const setBlocked = (next: boolean) => {
    if (blocked === next) return;
    blocked = next;
    options.onBlockedChange(next);
  };

  const play = () => {
    const result = element.play();
    if (result && typeof result.then === "function") {
      result.then(
        () => setBlocked(false),
        () => setBlocked(true),
      );
    } else {
      setBlocked(false);
    }
  };

  return {
    setTrack(next) {
      if (track === next) return;
      track = next;
      if (next === null) {
        element.srcObject = null;
        return;
      }
      element.srcObject = new MediaStream([next]);
      play();
    },
    currentTrack: () => track,
    isBlocked: () => blocked,
    retryPlayback() {
      if (element.srcObject) play();
    },
    cleanup() {
      const stream = element.srcObject;
      element.srcObject = null;
      if (stream instanceof MediaStream) {
        // Stop received tracks so the transceiver's media is fully released.
        for (const streamTrack of stream.getTracks()) streamTrack.stop();
      }
      track = null;
      element.remove();
      setBlocked(false);
    },
  };
}
