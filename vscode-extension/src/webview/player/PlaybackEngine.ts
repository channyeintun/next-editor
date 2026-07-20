import type { EolMode, SessionEvent } from "../../model/events";
import { LIMITS } from "../../model/limits";
import type { Bridge } from "../bridge/acquireBridge";
import { PROTOCOL_VERSION, type RecordingMetadataPayload } from "../bridge/protocol";
import type { PlaybackRenderer } from "./Renderer";
import { SessionReducer } from "./SessionReducer";
import { applyContentChanges } from "./PlaybackState";

export type EngineSnapshot = {
  phase: "connecting" | "loading" | "ready" | "error";
  error: string | null;
  playheadUs: number;
  durationUs: number;
  playing: boolean;
  rate: number;
  structureVersion: number;
  loadedEvents: number;
  totalEvents: number;
  fileName: string;
};

const WINDOW_SIZE = 20_000;
const FORWARD_SEEK_CHEAP_LIMIT = 5_000;

type PersistedState = { playheadUs?: number; rate?: number };

// Playback engine (plan §10.3/§10.4): pure TS, renderer-agnostic, owns
// canonical state via SessionReducer. Visual-only clock: desired session
// time derives from the anchor playhead + rate × elapsed monotonic time;
// events apply through the desired time each animation frame.
export class PlaybackEngine {
  reducer = new SessionReducer((id) => this.checkpoints.get(id));
  private events: SessionEvent[] = [];
  private nextIndex = 0;
  private readonly checkpoints = new Map<string, string>();
  private checkpointCodeUnits = 0;
  private metadata: RecordingMetadataPayload | null = null;

  private playing = false;
  private rate = 1;
  private playheadUs = 0;
  private anchorPlayheadUs = 0;
  private anchorWallMs = 0;
  private rafHandle: number | null = null;

  private snapshot: EngineSnapshot = {
    phase: "connecting",
    error: null,
    playheadUs: 0,
    durationUs: 0,
    playing: false,
    rate: 1,
    structureVersion: 0,
    loadedEvents: 0,
    totalEvents: 0,
    fileName: "",
  };
  private readonly listeners = new Set<() => void>();

  // Seek plan (built once after load).
  private checkpointIdxByDoc = new Map<
    string,
    { index: number; checkpointId: string; version: number; eol: EolMode }[]
  >();
  private documentStateIdxByDoc = new Map<string, number[]>();

  // Request correlation: duplicates and late responses are ignored.
  private requestCounter = 0;
  private readonly pending = new Map<
    string,
    {
      expected: "recording.eventWindow" | "recording.checkpoint";
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly surfaceAssignments = new Map<string, string>();
  private readonly rendererDocuments = new Set<string>();
  private readonly unsubscribeBridge: () => void;
  private seekGeneration = 0;
  private resumeAfterSeek = false;
  private disposed = false;

  constructor(
    private readonly bridge: Bridge,
    private readonly renderer: PlaybackRenderer,
  ) {
    this.unsubscribeBridge = bridge.onMessage((message) => {
      if (this.disposed) {
        return;
      }
      switch (message.type) {
        case "recording.metadata":
          void this.beginLoad(message.payload);
          break;
        case "recording.eventWindow": {
          const entry = this.pending.get(message.requestId);
          if (entry?.expected === message.type) {
            this.pending.delete(message.requestId);
            entry.resolve({
              fromSeq: message.fromSeq,
              events: message.events,
              done: message.done,
            });
          } else if (entry) {
            this.pending.delete(message.requestId);
            entry.reject(new Error(`unexpected ${message.type} response`));
          }
          break;
        }
        case "recording.checkpoint": {
          const entry = this.pending.get(message.requestId);
          if (entry?.expected === message.type) {
            this.pending.delete(message.requestId);
            entry.resolve(message.text);
          } else if (entry) {
            this.pending.delete(message.requestId);
            entry.reject(new Error(`unexpected ${message.type} response`));
          }
          break;
        }
        case "request.failed": {
          const entry = this.pending.get(message.requestId);
          if (entry) {
            this.pending.delete(message.requestId);
            entry.reject(new Error(message.message));
          } else if (message.requestId === "open") {
            this.setError(message.message);
          }
          break;
        }
        case "player.pause":
          this.pause();
          break;
        case "host.hello":
          if (message.protocolVersion !== PROTOCOL_VERSION) {
            this.setError(
              `host protocol ${message.protocolVersion} is unsupported (expected ${PROTOCOL_VERSION})`,
            );
          }
          break;
      }
    });
    bridge.post({ type: "webview.ready", protocolVersion: PROTOCOL_VERSION });
  }

  // ---- store interface ---------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EngineSnapshot => this.snapshot;

  private publish(patch: Partial<EngineSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setError(message: string): void {
    this.resumeAfterSeek = false;
    this.stopClock();
    this.publish({ phase: "error", error: message });
  }

  private bumpStructure(): void {
    this.surfaceAssignments.clear();
    this.publish({ structureVersion: this.snapshot.structureVersion + 1 });
  }

  // ---- loading -------------------------------------------------------------

  private request<T>(
    message: {
      type: "recording.requestWindow" | "recording.requestCheckpoint";
      requestId: string;
    } & Record<string, unknown>,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("playback engine is disposed"));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.requestId, {
        expected:
          message.type === "recording.requestWindow"
            ? "recording.eventWindow"
            : "recording.checkpoint",
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.bridge.post(message as never);
    });
  }

  private nextRequestId(): string {
    return `req-${++this.requestCounter}`;
  }

  private async fetchCheckpoint(documentId: string, checkpointId: string): Promise<string> {
    const cached = this.checkpoints.get(checkpointId);
    if (cached !== undefined) {
      return cached;
    }
    const text = await this.request<string>({
      type: "recording.requestCheckpoint",
      requestId: this.nextRequestId(),
      documentId,
      checkpointId,
    });
    const raced = this.checkpoints.get(checkpointId);
    if (raced !== undefined) {
      return raced;
    }
    if (this.checkpointCodeUnits + text.length > LIMITS.maxPlayerCheckpointCodeUnits) {
      throw new Error(
        `checkpoint cache exceeds ${LIMITS.maxPlayerCheckpointCodeUnits} UTF-16 code units`,
      );
    }
    this.checkpoints.set(checkpointId, text);
    this.checkpointCodeUnits += text.length;
    return text;
  }

  private async beginLoad(metadata: RecordingMetadataPayload): Promise<void> {
    if (this.metadata || this.snapshot.phase === "error") {
      return; // duplicate metadata and post-failure retries are safe no-ops
    }
    this.metadata = metadata;
    this.publish({
      phase: "loading",
      durationUs: metadata.durationUs,
      totalEvents: metadata.eventCount,
      fileName: metadata.fileName,
    });
    try {
      let fromSeq = 0;
      for (;;) {
        const window = await this.request<{
          fromSeq: number;
          events: SessionEvent[];
          done: boolean;
        }>({
          type: "recording.requestWindow",
          requestId: this.nextRequestId(),
          fromSeq,
          maxCount: WINDOW_SIZE,
        });
        if (window.fromSeq !== fromSeq) {
          throw new Error(`event window starts at ${window.fromSeq}, expected sequence ${fromSeq}`);
        }
        this.events.push(...window.events);
        fromSeq += window.events.length;
        this.publish({ loadedEvents: this.events.length });
        if (window.done || window.events.length === 0) {
          break;
        }
      }
      if (this.events.length !== metadata.eventCount) {
        throw new Error(
          `loaded event count ${this.events.length} does not match metadata ${metadata.eventCount}`,
        );
      }

      // Seek plan + checkpoint→document mapping.
      this.events.forEach((event, index) => {
        if (event.type === "document.enrolled") {
          const d = event.payload.descriptor;
          this.checkpointIdxByDoc.set(d.documentId, [
            {
              index,
              checkpointId: d.initialCheckpointId,
              version: d.initialVersion,
              eol: d.eol,
            },
          ]);
        } else if (event.type === "document.checkpoint") {
          this.checkpointIdxByDoc.get(event.payload.documentId)?.push({
            index,
            checkpointId: event.payload.checkpointId,
            version: event.payload.version,
            eol: event.payload.eol,
          });
        } else if (
          event.type === "document.patch" ||
          event.type === "document.eolChanged" ||
          event.type === "document.resumed"
        ) {
          const list = this.documentStateIdxByDoc.get(event.payload.documentId) ?? [];
          list.push(index);
          this.documentStateIdxByDoc.set(event.payload.documentId, list);
        }
      });

      // Prefetch checkpoints that can carry state not represented by a
      // patch. Interval/stop checkpoints are redundant during linear
      // forward playback and remain lazy for memory efficiency.
      for (const event of this.events) {
        if (event.type === "document.enrolled") {
          const d = event.payload.descriptor;
          await this.fetchCheckpoint(d.documentId, d.initialCheckpointId);
        } else if (
          event.type === "document.checkpoint" &&
          (event.payload.reason === "resume" ||
            event.payload.reason === "mismatch" ||
            event.payload.reason === "limit")
        ) {
          await this.fetchCheckpoint(event.payload.documentId, event.payload.checkpointId);
        }
      }

      // Restore persisted playhead (webview hide/reopen — plan §10.1);
      // fall back to the configured default speed for fresh opens.
      const persisted = (this.bridge.getState() ?? {}) as PersistedState;
      this.rate = persisted.rate ?? metadata.defaultSpeed ?? 1;
      this.publish({ phase: "ready", rate: this.rate });
      await this.seekTo(persisted.playheadUs ?? 0);
    } catch (error) {
      if (!this.disposed) {
        this.setError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  // ---- clock (plan §10.4) ---------------------------------------------------

  play(): void {
    if (this.playing || this.snapshot.phase !== "ready") {
      return;
    }
    if (this.playheadUs >= this.snapshot.durationUs) {
      // Restart from the beginning when at the end.
      void this.seekTo(0).then(() => this.play());
      return;
    }
    this.playing = true;
    this.anchorPlayheadUs = this.playheadUs;
    this.anchorWallMs = performance.now();
    this.publish({ playing: true });
    this.bridge.post({
      type: "player.stateChanged",
      playheadUs: this.playheadUs,
      rate: this.rate,
      playing: true,
    });
    const tick = () => {
      if (!this.playing) {
        return;
      }
      const desired =
        this.anchorPlayheadUs + (performance.now() - this.anchorWallMs) * 1000 * this.rate;
      const clamped = Math.min(desired, this.snapshot.durationUs);
      try {
        this.applyForwardTo(clamped);
      } catch (error) {
        this.setError(error instanceof Error ? error.message : String(error));
        return;
      }
      this.playheadUs = clamped;
      this.publish({ playheadUs: clamped });
      if (clamped >= this.snapshot.durationUs) {
        this.pause();
        return;
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  pause(): void {
    this.resumeAfterSeek = false;
    this.stopClock();
  }

  private stopClock(): void {
    if (!this.playing) {
      return;
    }
    this.playing = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.persist();
    this.publish({ playing: false });
    this.bridge.post({
      type: "player.stateChanged",
      playheadUs: this.playheadUs,
      rate: this.rate,
      playing: false,
    });
  }

  setRate(rate: number): void {
    this.anchorPlayheadUs = this.playheadUs;
    this.anchorWallMs = performance.now();
    this.rate = rate;
    this.persist();
    this.publish({ rate });
  }

  private persist(): void {
    this.bridge.setState({ playheadUs: this.playheadUs, rate: this.rate });
  }

  // ---- event application ----------------------------------------------------

  private applyForwardTo(targetUs: number): void {
    while (
      this.nextIndex < this.events.length &&
      (this.events[this.nextIndex] as SessionEvent).tUs <= targetUs
    ) {
      this.applyEvent(this.events[this.nextIndex] as SessionEvent);
      this.nextIndex += 1;
    }
  }

  private ensureRendererDocument(
    documentId: string,
    text: string,
    languageId: string,
    eol: EolMode,
  ): void {
    if (this.rendererDocuments.has(documentId)) {
      this.renderer.setDocumentText(documentId, text);
      this.renderer.setDocumentLanguage(documentId, languageId);
      this.renderer.setDocumentEol(documentId, eol);
      return;
    }
    this.renderer.createDocument(documentId, text, languageId);
    this.renderer.setDocumentEol(documentId, eol);
    this.rendererDocuments.add(documentId);
  }

  private applyEvent(event: SessionEvent): void {
    const issueCount = this.reducer.issues.length;
    this.reducer.apply(event);
    if (this.reducer.issues.length > issueCount) {
      const issue = this.reducer.issues[this.reducer.issues.length - 1];
      throw new Error(issue?.message ?? `invalid event at seq ${event.seq}`);
    }
    switch (event.type) {
      case "document.enrolled": {
        const d = event.payload.descriptor;
        this.ensureRendererDocument(
          d.documentId,
          this.checkpoints.get(d.initialCheckpointId) ?? "",
          d.languageId,
          d.eol,
        );
        this.bumpStructure();
        break;
      }
      case "document.patch":
        this.renderer.applyChanges(event.payload.documentId, event.payload.changes);
        this.renderer.setDocumentEol(event.payload.documentId, event.payload.eolAfter);
        break;
      case "document.checkpoint": {
        // Forward playback already has the exact text via patches; restore
        // only when the body is cached (seek fetches it explicitly).
        const text = this.checkpoints.get(event.payload.checkpointId);
        if (text !== undefined) {
          this.renderer.setDocumentText(event.payload.documentId, text);
        }
        this.renderer.setDocumentEol(event.payload.documentId, event.payload.eol);
        break;
      }
      case "document.languageChanged":
        this.renderer.setDocumentLanguage(event.payload.documentId, event.payload.languageId);
        break;
      case "document.eolChanged": {
        const doc = this.reducer.state.documents.get(event.payload.documentId);
        if (doc) {
          this.renderer.setDocumentText(event.payload.documentId, doc.text);
          this.renderer.setDocumentEol(event.payload.documentId, event.payload.eol);
        }
        break;
      }
      case "surface.selectionChanged":
        this.renderer.setSelections(event.payload.surfaceId, event.payload.selections);
        break;
      case "surface.viewportChanged":
        this.renderer.setViewport(event.payload.surfaceId, event.payload.visibleRanges);
        break;
      case "surface.opened":
      case "surface.closed":
      case "surface.focused":
      case "topology.snapshot":
        this.bumpStructure();
        break;
      default:
        break;
    }
  }

  // ---- seek (plan §10.3) ------------------------------------------------------

  async seekTo(targetUs: number): Promise<void> {
    if (this.snapshot.phase !== "ready" || this.disposed) {
      return;
    }
    const generation = ++this.seekGeneration;
    const clamped = Math.max(0, Math.min(this.snapshot.durationUs, targetUs));
    // Binary search: last event index with tUs <= clamped.
    let lo = 0;
    let hi = this.events.length - 1;
    let targetIndex = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.events[mid] as SessionEvent).tUs <= clamped) {
        targetIndex = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (this.playing) {
      this.resumeAfterSeek = true;
    }
    this.stopClock();

    try {
      if (
        targetIndex >= this.nextIndex - 1 &&
        targetIndex - this.nextIndex < FORWARD_SEEK_CHEAP_LIMIT
      ) {
        this.applyForwardTo(clamped);
      } else if (!(await this.rebuildAt(targetIndex, generation))) {
        return;
      }

      if (generation !== this.seekGeneration || this.disposed) {
        return;
      }
      this.playheadUs = clamped;
      this.anchorPlayheadUs = clamped;
      this.anchorWallMs = performance.now();
      this.persist();
      this.publish({ playheadUs: clamped });
      const shouldResume = this.resumeAfterSeek;
      this.resumeAfterSeek = false;
      if (shouldResume) {
        this.play();
      }
    } catch (error) {
      if (generation === this.seekGeneration && !this.disposed) {
        this.setError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async rebuildAt(targetIndex: number, generation: number): Promise<boolean> {
    // Fetch every checkpoint body the rebuild needs before touching state.
    const needed: {
      documentId: string;
      checkpointId: string;
      index: number;
      version: number;
      eol: EolMode;
    }[] = [];
    for (const [documentId, checkpoints] of this.checkpointIdxByDoc) {
      let latest: {
        index: number;
        checkpointId: string;
        version: number;
        eol: EolMode;
      } | null = null;
      for (const candidate of checkpoints) {
        if (candidate.index <= targetIndex) {
          latest = candidate;
        } else {
          break;
        }
      }
      if (latest) {
        needed.push({
          documentId,
          checkpointId: latest.checkpointId,
          index: latest.index,
          version: latest.version,
          eol: latest.eol,
        });
      }
    }
    for (const item of needed) {
      await this.fetchCheckpoint(item.documentId, item.checkpointId);
      if (generation !== this.seekGeneration || this.disposed) {
        return false;
      }
    }

    // Rebuild structural state without mutating document text. Document
    // state is reconstructed from the latest checkpoint plus subsequent
    // patch/EOL/resume events below.
    const reducer = new SessionReducer((id) => this.checkpoints.get(id));
    for (let i = 0; i <= targetIndex; i++) {
      const event = this.events[i] as SessionEvent;
      if (
        event.type === "document.patch" ||
        event.type === "document.checkpoint" ||
        event.type === "document.eolChanged" ||
        event.type === "document.resumed"
      ) {
        if (!reducer.state.documents.has(event.payload.documentId)) {
          throw new Error(`${event.type} for unknown document at seq ${event.seq}`);
        }
        reducer.state.appliedSeq = event.seq;
        reducer.state.timeUs = event.tUs;
        continue;
      }
      reducer.apply(event);
      const issue = reducer.issues[reducer.issues.length - 1];
      if (issue?.seq === event.seq) {
        throw new Error(issue.message);
      }
    }

    // Restore exact document state from checkpoint bodies plus every
    // subsequent state-changing event for that document.
    for (const item of needed) {
      let text = this.checkpoints.get(item.checkpointId) as string;
      let version = item.version;
      let eol = item.eol;
      const stateIndexes = this.documentStateIdxByDoc.get(item.documentId) ?? [];
      for (const index of stateIndexes) {
        if (index > item.index && index <= targetIndex) {
          const event = this.events[index] as SessionEvent;
          if (event.type === "document.patch") {
            if (event.payload.beforeVersion !== version) {
              throw new Error(
                `version mismatch at seq ${event.seq}: patch before=${event.payload.beforeVersion}, state=${version}`,
              );
            }
            text = applyContentChanges(text, event.payload.changes);
            version = event.payload.afterVersion;
            eol = event.payload.eolAfter;
          } else if (event.type === "document.eolChanged") {
            text = text.replace(/\r\n|\r|\n/g, event.payload.eol === "CRLF" ? "\r\n" : "\n");
            version = event.payload.version;
            eol = event.payload.eol;
          } else if (event.type === "document.resumed") {
            version = event.payload.version;
          }
        }
      }
      const doc = reducer.state.documents.get(item.documentId);
      if (doc) {
        doc.text = text;
        doc.version = version;
        doc.eol = eol;
      }
    }

    if (generation !== this.seekGeneration || this.disposed) {
      return false;
    }

    // Commit the rebuilt state and renderer projection only after every
    // async checkpoint request has completed and this is still the latest
    // seek. Older rapid-slider seeks cannot overwrite a newer result.
    for (const doc of reducer.state.documents.values()) {
      this.ensureRendererDocument(doc.documentId, doc.text, doc.languageId, doc.eol);
    }
    this.reducer = reducer;
    this.nextIndex = targetIndex + 1;

    // Re-apply per-surface view state for attached surfaces.
    for (const surface of reducer.state.surfaces.values()) {
      this.renderer.setSelections(surface.surfaceId, surface.selections);
      this.renderer.setViewport(surface.surfaceId, surface.visibleRanges);
    }
    this.bumpStructure();
    return true;
  }

  // ---- surface hosting --------------------------------------------------------

  /** Deterministic group→surface assignment for the reconstructed layout. */
  surfaceForGroupDocument(groupId: string, documentId: string): string {
    const key = `${groupId}|${documentId}`;
    const existing = this.surfaceAssignments.get(key);
    if (existing) {
      return existing;
    }
    const claimed = new Set(this.surfaceAssignments.values());
    const candidates = [...this.reducer.state.surfaces.values()]
      .filter((s) => s.open && s.documentId === documentId && !claimed.has(s.surfaceId))
      .sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
    const exact = candidates.find((surface) => surface.groupId === groupId);
    const surfaceId =
      exact?.surfaceId ?? candidates[0]?.surfaceId ?? `view-${groupId}-${documentId}`;
    this.surfaceAssignments.set(key, surfaceId);
    return surfaceId;
  }

  attachSurface(surfaceId: string, documentId: string, container: HTMLElement): void {
    if (this.disposed || !this.reducer.state.documents.has(documentId)) {
      return;
    }
    if (this.renderer.hasSurface(surfaceId)) {
      this.renderer.resumeSurface(surfaceId, container);
    } else {
      this.renderer.createSurface(surfaceId, documentId, container);
    }
    const surface = this.reducer.state.surfaces.get(surfaceId);
    if (surface) {
      this.renderer.setSelections(surfaceId, surface.selections);
      this.renderer.setViewport(surfaceId, surface.visibleRanges);
    }
  }

  detachSurface(surfaceId: string): void {
    if (!this.disposed) {
      this.renderer.suspendSurface(surfaceId);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.seekGeneration += 1;
    this.resumeAfterSeek = false;
    this.stopClock();
    this.disposed = true;
    this.unsubscribeBridge();
    for (const entry of this.pending.values()) {
      entry.reject(new Error("playback engine disposed"));
    }
    this.pending.clear();
    this.renderer.dispose();
    this.events = [];
    this.checkpointIdxByDoc.clear();
    this.documentStateIdxByDoc.clear();
    this.checkpoints.clear();
    this.checkpointCodeUnits = 0;
    this.rendererDocuments.clear();
    this.listeners.clear();
  }
}
