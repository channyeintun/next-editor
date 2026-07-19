import type { SessionEvent } from "../model/events";
import { openArtifact, type ArtifactReader } from "../storage/ArtifactReader";
import type { RecordingMetadataPayload } from "../webview/bridge/protocol";

// Host-side data plane for one opened recording (plan §10.1/§10.2):
// validated artifact access, cached events, checkpoint reads on demand.
export class PlaybackDataService {
  private eventsPromise: Promise<SessionEvent[]> | null = null;
  private readonly checkpointCache = new Map<string, string>();
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
    this.eventsPromise ??= this.reader.readEvents();
    return this.eventsPromise;
  }

  async eventWindow(
    fromSeq: number,
    maxCount: number,
  ): Promise<{ events: SessionEvent[]; done: boolean }> {
    const events = await this.loadEvents();
    const slice = events.slice(fromSeq, fromSeq + maxCount);
    return { events: slice, done: fromSeq + slice.length >= events.length };
  }

  async checkpoint(documentId: string, checkpointId: string): Promise<string> {
    const key = `${documentId}/${checkpointId}`;
    const cached = this.checkpointCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const text = await this.reader.readCheckpoint(documentId, checkpointId);
    // Bounded cache: keep it simple — cap total cached checkpoints.
    if (this.checkpointCache.size > 64) {
      const firstKey = this.checkpointCache.keys().next().value;
      if (firstKey !== undefined) {
        this.checkpointCache.delete(firstKey);
      }
    }
    this.checkpointCache.set(key, text);
    return text;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      await this.reader.close();
    }
  }
}
