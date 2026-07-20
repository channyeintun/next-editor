import { sha256Hex, utf8ByteLength } from "../capture/hash";
import type { EolMode, SessionEvent } from "../model/events";
import { applyContentChanges } from "../webview/player/PlaybackState";

type FinalDocument = {
  text: string;
  version: number;
  eol: EolMode;
  sha256: string;
};

export type ReplayValidationResult = {
  ok: boolean;
  errors: string[];
  finalDocuments: Map<string, FinalDocument>;
};

class ReplayValidationMachine {
  private readonly errors: string[] = [];
  private readonly documents = new Map<string, FinalDocument>();
  private readonly surfaces = new Map<string, string>();
  private expectedSeq = 0;
  private lastTUs = -1;

  /** Returns false only when a sequence gap makes later replay ambiguous. */
  apply(event: SessionEvent, checkpointText?: string): boolean {
    if (event.seq !== this.expectedSeq) {
      this.error(event.seq, `sequence gap (expected ${this.expectedSeq})`);
      return false;
    }
    this.expectedSeq += 1;
    if (event.tUs < this.lastTUs) {
      this.error(event.seq, "decreasing timestamp");
    }
    this.lastTUs = event.tUs;

    switch (event.type) {
      case "document.enrolled": {
        const descriptor = event.payload.descriptor;
        if (this.documents.has(descriptor.documentId)) {
          this.error(event.seq, `duplicate document enrollment ${descriptor.documentId}`);
          break;
        }
        if (checkpointText === undefined) {
          this.error(event.seq, `missing initial checkpoint ${descriptor.initialCheckpointId}`);
          break;
        }
        const digest = sha256Hex(checkpointText);
        if (descriptor.sha256 && digest !== descriptor.sha256) {
          this.error(event.seq, `initial checkpoint hash mismatch for ${descriptor.documentId}`);
        }
        if (utf8ByteLength(checkpointText) !== descriptor.byteLength) {
          this.error(
            event.seq,
            `initial checkpoint byte length mismatch for ${descriptor.documentId}`,
          );
        }
        this.documents.set(descriptor.documentId, {
          text: checkpointText,
          version: descriptor.initialVersion,
          eol: descriptor.eol,
          sha256: digest,
        });
        break;
      }
      case "document.patch": {
        const document = this.documents.get(event.payload.documentId);
        if (!document) {
          this.error(event.seq, `patch for unknown document ${event.payload.documentId}`);
          break;
        }
        if (event.payload.beforeVersion !== document.version) {
          this.error(
            event.seq,
            `version mismatch: patch before=${event.payload.beforeVersion}, state=${document.version}`,
          );
        }
        if (event.payload.afterVersion <= event.payload.beforeVersion) {
          this.error(event.seq, "patch afterVersion must advance");
        }
        if (event.payload.eolBefore !== document.eol) {
          this.error(
            event.seq,
            `EOL mismatch: patch before=${event.payload.eolBefore}, state=${document.eol}`,
          );
        }
        if (event.payload.beforeHash && event.payload.beforeHash !== document.sha256) {
          this.error(event.seq, "beforeHash mismatch");
        }
        let text = document.text;
        let valid = true;
        for (const change of event.payload.changes) {
          try {
            text = applyContentChanges(text, [change]);
          } catch {
            this.error(event.seq, "change range out of bounds");
            valid = false;
            break;
          }
        }
        if (!valid) {
          break;
        }
        const after = sha256Hex(text);
        if (event.payload.afterHash && event.payload.afterHash !== after) {
          this.error(event.seq, "afterHash mismatch");
        }
        document.text = text;
        document.version = event.payload.afterVersion;
        document.eol = event.payload.eolAfter;
        document.sha256 = after;
        break;
      }
      case "document.eolChanged": {
        const document = this.documents.get(event.payload.documentId);
        if (!document) {
          this.error(event.seq, "eolChanged for unknown document");
          break;
        }
        document.text = document.text.replace(
          /\r\n|\r|\n/g,
          event.payload.eol === "CRLF" ? "\r\n" : "\n",
        );
        document.version = event.payload.version;
        document.eol = event.payload.eol;
        document.sha256 = sha256Hex(document.text);
        break;
      }
      case "document.checkpoint": {
        const document = this.documents.get(event.payload.documentId);
        if (!document) {
          this.error(event.seq, "checkpoint for unknown document");
          break;
        }
        if (checkpointText === undefined) {
          this.error(event.seq, `missing checkpoint body ${event.payload.checkpointId}`);
          break;
        }
        const digest = sha256Hex(checkpointText);
        if (event.payload.sha256 && digest !== event.payload.sha256) {
          this.error(event.seq, `checkpoint body hash mismatch ${event.payload.checkpointId}`);
        }
        if (utf8ByteLength(checkpointText) !== event.payload.byteLength) {
          this.error(event.seq, `checkpoint byte length mismatch ${event.payload.checkpointId}`);
        }
        if (
          event.payload.reason === "enrollment" ||
          event.payload.reason === "interval" ||
          event.payload.reason === "stop"
        ) {
          if (event.payload.version !== document.version) {
            this.error(
              event.seq,
              `continuous checkpoint version ${event.payload.version} != state ${document.version}`,
            );
          }
          if (event.payload.eol !== document.eol) {
            this.error(
              event.seq,
              `continuous checkpoint EOL ${event.payload.eol} != state ${document.eol}`,
            );
          }
          if (digest !== document.sha256) {
            this.error(event.seq, "continuous checkpoint does not match replay state");
          }
        }
        document.text = checkpointText;
        document.version = event.payload.version;
        document.eol = event.payload.eol;
        document.sha256 = digest;
        break;
      }
      case "document.resumed": {
        const document = this.documents.get(event.payload.documentId);
        if (!document) {
          this.error(event.seq, `${event.type} for unknown document`);
        } else {
          document.version = event.payload.version;
        }
        break;
      }
      case "document.saved":
      case "document.closed":
      case "document.languageChanged": {
        if (!this.documents.has(event.payload.documentId)) {
          this.error(event.seq, `${event.type} for unknown document`);
        }
        break;
      }
      case "surface.opened": {
        if (!this.documents.has(event.payload.documentId)) {
          this.error(event.seq, "surface.opened for unknown document");
        }
        const existingDocumentId = this.surfaces.get(event.payload.surfaceId);
        if (existingDocumentId !== undefined && existingDocumentId !== event.payload.documentId) {
          this.error(event.seq, "surface reopened for a different document");
        }
        this.surfaces.set(event.payload.surfaceId, event.payload.documentId);
        break;
      }
      case "surface.closed":
      case "surface.focused": {
        if (!this.surfaces.has(event.payload.surfaceId)) {
          this.error(event.seq, `${event.type} for unknown surface`);
        }
        break;
      }
      case "surface.selectionChanged":
      case "surface.viewportChanged": {
        const documentId = this.surfaces.get(event.payload.surfaceId);
        if (documentId === undefined) {
          this.error(event.seq, `${event.type} for unknown surface`);
        } else if (documentId !== event.payload.documentId) {
          this.error(event.seq, `${event.type} document does not match surface`);
        }
        break;
      }
      default:
        break;
    }
    return true;
  }

  expects(event: SessionEvent): boolean {
    return event.seq === this.expectedSeq;
  }

  result(): ReplayValidationResult {
    return {
      ok: this.errors.length === 0,
      errors: this.errors,
      finalDocuments: this.documents,
    };
  }

  private error(seq: number, message: string): void {
    this.errors.push(`seq ${seq}: ${message}`);
  }
}

function checkpointIdFor(event: SessionEvent): string | undefined {
  if (event.type === "document.enrolled") {
    return event.payload.descriptor.initialCheckpointId;
  }
  if (event.type === "document.checkpoint") {
    return event.payload.checkpointId;
  }
  return undefined;
}

// Pure replay validation (plan §9.3 / Phase 4): verifies sequence and time
// invariants, referenced IDs, patch application bounds, and every recorded
// hash. Runs before finalization and in tests.
export function validateSessionReplay(
  events: readonly SessionEvent[],
  getCheckpointText: (checkpointId: string) => string | undefined,
): ReplayValidationResult {
  const machine = new ReplayValidationMachine();
  for (const event of events) {
    const checkpointId = machine.expects(event) ? checkpointIdFor(event) : undefined;
    const checkpointText = checkpointId === undefined ? undefined : getCheckpointText(checkpointId);
    if (!machine.apply(event, checkpointText)) {
      break;
    }
  }
  return machine.result();
}

/** Memory-bounded variant for finalization: checkpoint bodies are read on demand. */
export async function validateSessionReplayAsync(
  events: readonly SessionEvent[],
  getCheckpointText: (checkpointId: string) => Promise<string | undefined>,
): Promise<ReplayValidationResult> {
  const machine = new ReplayValidationMachine();
  for (const event of events) {
    const checkpointId = machine.expects(event) ? checkpointIdFor(event) : undefined;
    const checkpointText =
      checkpointId === undefined ? undefined : await getCheckpointText(checkpointId);
    if (!machine.apply(event, checkpointText)) {
      break;
    }
  }
  return machine.result();
}
