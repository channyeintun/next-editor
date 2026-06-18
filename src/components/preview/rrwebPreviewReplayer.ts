import { Replayer } from "rrweb";
import type { eventWithTime } from "rrweb";

export interface RrwebPreviewReplayerOptions {
  // Host element the Replayer mounts its wrapper/iframe into.
  root: HTMLElement;
  // Full, time-ordered rrweb event stream (Meta + FullSnapshot + incrementals).
  events: eventWithTime[];
  // Recording-relative time (ms) of the first snapshot — i.e. the recorded
  // `previewInitialDocuments[0].time`. The replay timeline's `currentTime` is on
  // this same recording clock, so the rrweb offset is `currentTime - baseTime`.
  baseTime: number;
}

// Maps the recording-relative playback `currentTime` to the rrweb `pause` offset
// (both clocks advance at real time, so it is a simple shift, clamped at 0).
export function computeRrwebOffsetMs(currentTime: number, baseTime: number): number {
  return Math.max(0, currentTime - baseTime);
}

// Drives an rrweb `Replayer` from the recording timeline. The host timeline is
// the single clock: every tick/seek calls `seekToRecordingTime`, which casts all
// events up to that offset deterministically via `Replayer.pause`. The Replayer's
// own timer never autoplays. DOM, scroll, input and pointer all live in one rrweb
// event stream, so they stay coupled (unlike the legacy two-applier model).
export class RrwebPreviewReplayer {
  private readonly replayer: Replayer;
  private readonly baseTime: number;
  private destroyed = false;

  constructor({ root, events, baseTime }: RrwebPreviewReplayerOptions) {
    this.baseTime = baseTime;
    this.replayer = new Replayer(events, {
      root,
      liveMode: false,
      mouseTail: false,
      showWarning: false,
      showDebug: false,
      // We seek explicitly; the player must never run its own timer.
      speed: 1,
      // Real DOM replay into the mounted iframe (no virtual DOM diffing layer).
      useVirtualDom: false,
    });
    this.makeResponsive();
    // Render the initial snapshot immediately so the panel is never blank before
    // the first tick arrives.
    this.seekToRecordingTime(baseTime);
  }

  seekToRecordingTime(currentTime: number): void {
    if (this.destroyed) {
      return;
    }

    try {
      this.replayer.pause(computeRrwebOffsetMs(currentTime, this.baseTime));
    } catch {
      // A single failed cast must not break the timeline; the next tick retries.
    }
  }

  // The replay iframe fills the preview panel rather than rrweb's Meta-derived
  // fixed pixel size, so it tracks the recorded float/unfloat panel size. Content
  // fidelity comes from replaying the recorded DOM (exact rows/translateY), not
  // from re-running the page at a specific width.
  private makeResponsive(): void {
    const { wrapper, iframe } = this.replayer;

    if (wrapper) {
      wrapper.style.width = "100%";
      wrapper.style.height = "100%";
      // rrweb's fake pointer is unused — we have our own cursor-replay overlay.
      const mouse = wrapper.querySelector<HTMLElement>(".replayer-mouse");
      if (mouse) {
        mouse.style.display = "none";
      }
    }

    if (iframe) {
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.border = "0";
      iframe.style.background = "transparent";
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    try {
      this.replayer.destroy();
    } catch {
      // ignore teardown races
    }
  }
}
