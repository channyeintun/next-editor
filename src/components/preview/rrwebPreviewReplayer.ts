import type { Replayer } from "@rrweb/replay";
import type { eventWithTime } from "@rrweb/types";

type ReplayerConstructor = (typeof import("@rrweb/replay"))["Replayer"];
type ReplayModuleLoader = () => Promise<{ Replayer: ReplayerConstructor }>;

export interface RrwebPreviewReplayerOptions {
  // Host element the Replayer mounts its wrapper/iframe into.
  root: HTMLElement;
  // Full, time-ordered rrweb event stream (Meta + FullSnapshot + incrementals),
  // already rebased onto the recording clock by buildRrwebReplayEvents.
  events: eventWithTime[];
}

// Maps the recording-relative playback `currentTime` to the rrweb `pause` offset.
// rrweb measures that offset from its first event, and the events already carry
// recording-clock timestamps, so it is a simple shift, clamped at 0.
export function computeRrwebOffsetMs(currentTime: number, firstEventTime: number): number {
  return Math.max(0, currentTime - firstEventTime);
}

// Drives an rrweb `Replayer` from the recording timeline. The host timeline is
// the single clock: every tick/seek calls `seekToRecordingTime`, which casts all
// events up to that offset deterministically via `Replayer.pause`. The Replayer's
// own timer never autoplays. DOM, scroll, input and pointer all live in one rrweb
// event stream, so they stay coupled (unlike the legacy two-applier model).
export class RrwebPreviewReplayer {
  private replayer: Replayer;
  private readonly ReplayerConstructor: ReplayerConstructor;
  private readonly root: HTMLElement;
  private readonly events: eventWithTime[];
  // Recording-clock time of the first event: rrweb's offset zero. Not the seed's
  // `time`, which is when the host received it, after rrweb had stamped its Meta
  // event and serialized the page.
  private readonly firstEventTime: number;
  private lastOffsetMs = 0;
  private destroyed = false;

  constructor(
    { root, events }: RrwebPreviewReplayerOptions,
    ReplayerConstructor: ReplayerConstructor,
  ) {
    this.root = root;
    this.events = events;
    this.firstEventTime = events[0]?.timestamp ?? 0;
    this.ReplayerConstructor = ReplayerConstructor;
    this.replayer = this.createReplayer();
    // Render the initial snapshot immediately so the panel is never blank before
    // the first tick arrives.
    this.seekToRecordingTime(this.firstEventTime);
  }

  private createReplayer(): Replayer {
    const replayer = new this.ReplayerConstructor(this.events, {
      root: this.root,
      liveMode: false,
      mouseTail: false,
      showWarning: false,
      showDebug: false,
      // We seek explicitly; the player must never run its own timer.
      speed: 1,
      // Real DOM replay into the mounted iframe (no virtual DOM diffing layer).
      useVirtualDom: false,
      insertStyleRules: ["::selection { background-color: #b4d5fe; }"],
    });
    this.makeResponsive(replayer);
    return replayer;
  }

  private restartReplayer(): void {
    try {
      this.replayer.destroy();
    } catch {
      // A teardown race must not prevent a clean replacement.
    }

    this.root.replaceChildren();
    this.replayer = this.createReplayer();
  }

  seekToRecordingTime(currentTime: number): void {
    if (this.destroyed) {
      return;
    }

    const offsetMs = computeRrwebOffsetMs(currentTime, this.firstEventTime);

    try {
      // rrweb cannot reliably seek a used Replayer to offset zero: pause(0)
      // cancels its zero-delay snapshot cast after clearing the mirror, leaving
      // the DOM from the previous pass mounted. Start/restart from a fresh mirror
      // and iframe so the second playback receives the same baseline as the first.
      if (offsetMs === 0 && this.lastOffsetMs > 0) {
        this.restartReplayer();
      }

      this.replayer.pause(offsetMs);
      this.lastOffsetMs = offsetMs;
    } catch {
      // A single failed cast must not break the timeline; the next tick retries.
    }
  }

  // The replay iframe fills the preview panel rather than rrweb's Meta-derived
  // fixed pixel size, so it tracks the recorded float/unfloat panel size. Content
  // fidelity comes from replaying the recorded DOM (exact rows/translateY), not
  // from re-running the page at a specific width.
  private makeResponsive(replayer: Replayer): void {
    const { wrapper, iframe } = replayer;

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

/** Loads the replay implementation only when a recording actually enters rrweb
 * replay mode. Recording/editing routes never evaluate the replay package. */
export async function createRrwebPreviewReplayer(
  options: RrwebPreviewReplayerOptions,
  loadReplayModule: ReplayModuleLoader = () => import("@rrweb/replay"),
): Promise<RrwebPreviewReplayer> {
  const { Replayer } = await loadReplayModule();
  return new RrwebPreviewReplayer(options, Replayer);
}
