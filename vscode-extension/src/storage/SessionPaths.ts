import * as path from "node:path";

// Working-session layout under the extension's globalStorageUri
// (plan §9.1). Node fs APIs are allowed here because this is local
// extension-owned storage.
export class SessionPaths {
  constructor(
    readonly storageRoot: string,
    readonly sessionId: string,
  ) {}

  static sessionsRoot(storageRoot: string): string {
    return path.join(storageRoot, "sessions");
  }

  static recordingsRoot(storageRoot: string): string {
    return path.join(storageRoot, "recordings");
  }

  get sessionDir(): string {
    return path.join(SessionPaths.sessionsRoot(this.storageRoot), this.sessionId);
  }

  get metadataFile(): string {
    return path.join(this.sessionDir, "session.json");
  }

  get journalFile(): string {
    return path.join(this.sessionDir, "events.ndjson");
  }

  get checkpointsDir(): string {
    return path.join(this.sessionDir, "checkpoints");
  }

  get audioDir(): string {
    return path.join(this.sessionDir, "audio");
  }

  get recoveryFile(): string {
    return path.join(this.sessionDir, "recovery.json");
  }

  get finalizedFile(): string {
    return path.join(this.sessionDir, "finalized.json");
  }
}
