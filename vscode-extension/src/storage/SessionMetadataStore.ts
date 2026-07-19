import { atomicWriteJson, readJsonFile } from "./atomicFile";
import type { SessionPaths } from "./SessionPaths";

// session.json is the lifecycle authority (plan §9.2): sufficient to
// distinguish active, interrupted, finalized, failed, discarded sessions.
export type SessionLifecycleState =
  | "preparing"
  | "recording"
  | "stopping"
  | "finalizing"
  | "finalized"
  | "failed"
  | "discarded";

export type SessionMetadata = {
  formatVersion: 1;
  sessionId: string;
  state: SessionLifecycleState;
  createdAt: string;
  updatedAt: string;
  lastDurableSeq: number;
  extensionVersion: string;
  vscodeVersion: string;
  failure: { message: string; at: string } | null;
  artifactPath: string | null;
};

export class SessionMetadataStore {
  private current: SessionMetadata;

  constructor(
    private readonly paths: SessionPaths,
    initial: SessionMetadata,
  ) {
    this.current = initial;
  }

  static createInitial(
    paths: SessionPaths,
    info: { extensionVersion: string; vscodeVersion: string },
  ): SessionMetadataStore {
    const now = new Date().toISOString();
    return new SessionMetadataStore(paths, {
      formatVersion: 1,
      sessionId: paths.sessionId,
      state: "preparing",
      createdAt: now,
      updatedAt: now,
      lastDurableSeq: -1,
      extensionVersion: info.extensionVersion,
      vscodeVersion: info.vscodeVersion,
      failure: null,
      artifactPath: null,
    });
  }

  static async read(paths: SessionPaths): Promise<SessionMetadata | null> {
    return readJsonFile<SessionMetadata>(paths.metadataFile);
  }

  get metadata(): SessionMetadata {
    return this.current;
  }

  async update(
    patch: Partial<Omit<SessionMetadata, "formatVersion" | "sessionId" | "createdAt">>,
  ): Promise<SessionMetadata> {
    this.current = {
      ...this.current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteJson(this.paths.metadataFile, this.current);
    return this.current;
  }
}
