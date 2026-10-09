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

// rrweb EventType.IncrementalSnapshot and IncrementalSource.MouseMove, hardcoded
// (like rrwebPreview.ts) so this module keeps its rrweb imports type-only.
const RRWEB_EVENT_TYPE_INCREMENTAL_SNAPSHOT = 3;
const RRWEB_INCREMENTAL_SOURCE_MOUSE_MOVE = 1;

// After casting a MouseMove, rrweb's next `pause` skips only the events at or
// before its FIRST sampled position (up to ~500ms before the event), so every
// later seek re-cast the mutations in that window. Re-casting is not
// idempotent: rrweb drops, in place on the event, each remove whose node is
// already gone, so the next rebuild (a backward seek, a restart, a resume)
// replayed the swapped-out content stacked. Seeks here always cast
// synchronously, which reads only a MouseMove's last position, so anchoring its
// sampled offsets at the event's own time leaves nothing behind it to re-cast.
function withoutMouseMoveLookback(event: eventWithTime): eventWithTime {
  const { type, data } = event as unknown as {
    type: number;
    data: { source?: number; positions?: { timeOffset: number }[] };
  };
  if (
    type !== RRWEB_EVENT_TYPE_INCREMENTAL_SNAPSHOT ||
    data.source !== RRWEB_INCREMENTAL_SOURCE_MOUSE_MOVE ||
    !data.positions?.some((position) => position.timeOffset !== 0)
  ) {
    return event;
  }

  return {
    ...event,
    data: {
      ...data,
      positions: data.positions.map((position) => ({ ...position, timeOffset: 0 })),
    },
  } as eventWithTime;
}

// How many leading events of a time-sorted stream rrweb's `pause` casts at
// `baselineTime`: it casts by the raw `event.timestamp < baselineTime`
// (MouseMove's earlier `positions[0]` time only shifts its timer delay).
function countEventsBefore(events: readonly eventWithTime[], baselineTime: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid].timestamp < baselineTime) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

// Drives an rrweb `Replayer` from the recording timeline. The host timeline is
// the single clock: every tick/seek calls `seekToRecordingTime`, which casts all
// events up to that offset deterministically via `Replayer.pause` (a play that is
// paused at once, which clears rrweb's timer), so the Replayer never advances on
// its own. DOM, scroll, input and pointer all live in one rrweb
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
  // How many leading events the current Replayer has cast, and the baseline its
  // last `pause` cast them up to; the count is null until its first `pause`.
  private castEventCount: number | null = null;
  private castBaselineTime = 0;
  private destroyed = false;

  constructor(
    { root, events }: RrwebPreviewReplayerOptions,
    ReplayerConstructor: ReplayerConstructor,
  ) {
    this.root = root;
    this.events = events.map(withoutMouseMoveLookback);
    this.firstEventTime = events[0]?.timestamp ?? 0;
    this.ReplayerConstructor = ReplayerConstructor;
    // No seek here: pause(0) casts nothing, and rrweb paints the first
    // FullSnapshot itself on a 1ms timer after construction, which is what keeps
    // the panel from being blank before the first tick.
    this.replayer = this.createReplayer();
  }

  private createReplayer(): Replayer {
    const replayer = new this.ReplayerConstructor(this.events, {
      root: this.root,
      liveMode: false,
      mouseTail: false,
      showWarning: false,
      showDebug: false,
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
    this.castEventCount = null;
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

      // Most ticks cross no event, and pause(offset) would still rebuild rrweb's
      // queue of every remaining event to cast nothing new. So a forward move
      // reaches rrweb only once it crosses an event; backward moves and a
      // Replayer's first seek always do.
      const baselineTime = this.firstEventTime + offsetMs;
      if (this.castEventCount !== null && offsetMs >= this.lastOffsetMs) {
        const nextEvent = this.events[this.castEventCount];
        if (!nextEvent || nextEvent.timestamp >= baselineTime) {
          this.lastOffsetMs = offsetMs;
          return;
        }
      }

      this.replayer.pause(offsetMs);
      this.castEventCount = countEventsBefore(this.events, baselineTime);
      this.castBaselineTime = baselineTime;
      this.lastOffsetMs = offsetMs;
    } catch {
      // A single failed cast must not break the timeline; the next tick retries.
    }
  }

  // Hands the Replayer events streamed in after it was built (already rebased
  // like its own), instead of rebuilding it from the last FullSnapshot. Only
  // events strictly after its last one are taken, so its stream stays exactly
  // what a rebuild from the longer recording would replay; otherwise this adds
  // nothing and returns false, and the caller rebuilds.
  appendEvents(events: readonly eventWithTime[]): boolean {
    const lastEvent = this.events.at(-1);
    if (this.destroyed || (events[0] && lastEvent && events[0].timestamp <= lastEvent.timestamp)) {
      return false;
    }

    for (const event of events) {
      const replayEvent = withoutMouseMoveLookback(event);
      this.events.push(replayEvent);
      this.replayer.addEvent(replayEvent);
    }
    // rrweb casts an added event at once when it is older than its last
    // seek's baseline, and otherwise when a later seek crosses it.
    if (this.castEventCount !== null) {
      this.castEventCount = countEventsBefore(this.events, this.castBaselineTime);
    }
    return true;
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
      // rrweb creates this frame with no name; give it the live frame's title
      // so screen readers can identify it during playback (WCAG 4.1.2, H64).
      iframe.title = "Runtime Preview";
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
