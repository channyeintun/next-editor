import { Buffer } from "node:buffer";
import type { SessionEvent } from "../model/events";
import { LIMITS } from "../model/limits";
import { openArtifact, type ArtifactReader } from "../storage/ArtifactReader";
import { validateSessionReplayAsync } from "../storage/replayValidation";
import type { RecordingMetadataPayload } from "../webview/bridge/protocol";

// Host-side data plane for one opened recording (plan §10.1/§10.2):
// validated artifact access, cached events, checkpoint reads on demand.
export class PlaybackDataService {
  private eventsPromise: Promise<SessionEvent[]> | null = null;
  private readonly checkpointCache = new Map<string, { text: string; bytes: number }>();
  private checkpointCacheBytes = 0;
  private disposed = false;

  private constructor(
    private readonly reader: ArtifactReader,
    readonly fileName: string,
  ) {}

  static async open(filePath: string, fileName: string): Promise<PlaybackDataService> {
    const reader = await openArtifact(filePath);
    return new PlaybackDataService(reader, fileName);
  }

  metadata(defaultSpeed = 1): RecordingMetadataPayload {
    const manifest = this.reader.manifest;
    return {
      fileName: this.fileName,
      sessionId: manifest.sessionId,
      durationUs: manifest.durationUs,
      eventCount: manifest.eventJournalRef.eventCount,
      hasAudio: manifest.capabilities.audio,
      defaultSpeed,
      documents: manifest.documents.map((doc) => ({
        documentId: doc.documentId,
        displayName: doc.displayName,
        logicalPath: doc.logicalPath,
        languageId: doc.languageId,
      })),
      workspaceRoots: manifest.workspaceRoots.map((root) => ({
        rootId: root.rootId,
        name: root.name,
      })),
    };
  }

  private loadEvents(): Promise<SessionEvent[]> {
    this.throwIfDisposed();
    this.eventsPromise ??= this.loadAndValidateEvents();
    return this.eventsPromise;
  }

  private async loadAndValidateEvents(): Promise<SessionEvent[]> {
    const events = await this.reader.readEvents();
    const checkpointDocuments = new Map<string, string>();
    for (const event of events) {
      if (event.type === "document.enrolled") {
        checkpointDocuments.set(
          event.payload.descriptor.initialCheckpointId,
          event.payload.descriptor.documentId,
        );
      } else if (event.type === "document.checkpoint") {
        checkpointDocuments.set(event.payload.checkpointId, event.payload.documentId);
      }
    }
    const validation = await validateSessionReplayAsync(events, async (checkpointId) => {
      const documentId = checkpointDocuments.get(checkpointId);
      return documentId === undefined ? undefined : this.checkpoint(documentId, checkpointId);
    });
    if (!validation.ok) {
      throw new Error(
        `recording replay validation failed: ${validation.errors.slice(0, 3).join("; ")}`,
      );
    }
    return events;
  }

  async eventWindow(
    fromSeq: number,
    maxCount: number,
  ): Promise<{ events: SessionEvent[]; done: boolean }> {
    const events = await this.loadEvents();
    this.throwIfDisposed();
    const slice = events.slice(fromSeq, fromSeq + maxCount);
    const done = fromSeq + slice.length >= events.length;
    if (done) {
      // postMessage receives the sliced window; retaining the complete
      // host-side array would duplicate the webview's event store.
      this.eventsPromise = null;
      this.reader.releaseEvents();
    }
    return { events: slice, done };
  }

  async checkpoint(documentId: string, checkpointId: string): Promise<string> {
    this.throwIfDisposed();
    const key = `${documentId}/${checkpointId}`;
    const cached = this.checkpointCache.get(key);
    if (cached !== undefined) {
      this.checkpointCache.delete(key);
      this.checkpointCache.set(key, cached);
      return cached.text;
    }
    const text = await this.reader.readCheckpoint(documentId, checkpointId);
    this.throwIfDisposed();
    const raced = this.checkpointCache.get(key);
    if (raced !== undefined) {
      return raced.text;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    const maxCacheBytes = LIMITS.maxHostCheckpointCacheBytes;
    if (bytes <= maxCacheBytes) {
      while (this.checkpointCacheBytes + bytes > maxCacheBytes) {
        const firstKey = this.checkpointCache.keys().next().value;
        if (firstKey === undefined) {
          break;
        }
        const removed = this.checkpointCache.get(firstKey);
        this.checkpointCache.delete(firstKey);
        if (removed) {
          this.checkpointCacheBytes -= removed.bytes;
        }
      }
      this.checkpointCache.set(key, { text, bytes });
      this.checkpointCacheBytes += bytes;
    }
    return text;
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new Error("playback data service is disposed");
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.checkpointCache.clear();
      this.checkpointCacheBytes = 0;
      await this.reader.close();
    }
  }
}
