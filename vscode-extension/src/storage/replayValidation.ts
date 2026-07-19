import { sha256Hex, utf8ByteLength } from "../capture/hash";
import { applyContentChanges } from "../webview/player/PlaybackState";
import type { SessionEvent } from "../model/events";

export type ReplayValidationResult = {
  ok: boolean;
  errors: string[];
  finalDocuments: Map<string, { text: string; version: number; sha256: string }>;
};

// Pure replay validation (plan §9.3 / Phase 4): verifies sequence and time
// invariants, referenced IDs, patch application bounds, and every recorded
// hash. Runs before finalization and in tests.
export function validateSessionReplay(
  events: readonly SessionEvent[],
  getCheckpointText: (checkpointId: string) => string | undefined,
): ReplayValidationResult {
  const errors: string[] = [];
  const documents = new Map<string, { text: string; version: number; sha256: string }>();
  const knownSurfaces = new Set<string>();
  let expectedSeq = 0;
  let lastTUs = -1;

  const err = (seq: number, message: string) => {
    errors.push(`seq ${seq}: ${message}`);
  };

  for (const event of events) {
    if (event.seq !== expectedSeq) {
      err(event.seq, `sequence gap (expected ${expectedSeq})`);
      break;
    }
    expectedSeq += 1;
    if (event.tUs < lastTUs) {
      err(event.seq, "decreasing timestamp");
    }
    lastTUs = event.tUs;

    switch (event.type) {
      case "document.enrolled": {
        const d = event.payload.descriptor;
        const text = getCheckpointText(d.initialCheckpointId);
        if (text === undefined) {
          err(event.seq, `missing initial checkpoint ${d.initialCheckpointId}`);
          break;
        }
        if (d.sha256 && sha256Hex(text) !== d.sha256) {
          err(event.seq, `initial checkpoint hash mismatch for ${d.documentId}`);
        }
        documents.set(d.documentId, {
          text,
          version: d.initialVersion,
          sha256: sha256Hex(text),
        });
        break;
      }
      case "document.patch": {
        const doc = documents.get(event.payload.documentId);
        if (!doc) {
          err(event.seq, `patch for unknown document ${event.payload.documentId}`);
          break;
        }
        if (event.payload.beforeVersion !== doc.version) {
          err(
            event.seq,
            `version mismatch: patch before=${event.payload.beforeVersion}, state=${doc.version}`,
          );
        }
        if (event.payload.beforeHash && event.payload.beforeHash !== doc.sha256) {
          err(event.seq, "beforeHash mismatch");
        }
        let text = doc.text;
        let valid = true;
        for (const change of event.payload.changes) {
          if (
            change.rangeOffsetUtf16 < 0 ||
            change.rangeLengthUtf16 < 0 ||
            change.rangeOffsetUtf16 + change.rangeLengthUtf16 > text.length
          ) {
            err(event.seq, "change range out of bounds");
            valid = false;
            break;
          }
          text = applyContentChanges(text, [change]);
        }
        if (!valid) {
          break;
        }
        const after = sha256Hex(text);
        if (event.payload.afterHash && event.payload.afterHash !== after) {
          err(event.seq, "afterHash mismatch");
        }
        doc.text = text;
        doc.version = event.payload.afterVersion;
        doc.sha256 = after;
        break;
      }
      case "document.eolChanged": {
        const doc = documents.get(event.payload.documentId);
        if (!doc) {
          err(event.seq, "eolChanged for unknown document");
          break;
        }
        doc.text = doc.text.replace(/\r\n|\r|\n/g, event.payload.eol === "CRLF" ? "\r\n" : "\n");
        doc.version = event.payload.version;
        doc.sha256 = sha256Hex(doc.text);
        break;
      }
      case "document.checkpoint": {
        const doc = documents.get(event.payload.documentId);
        if (!doc) {
          err(event.seq, "checkpoint for unknown document");
          break;
        }
        const text = getCheckpointText(event.payload.checkpointId);
        if (text === undefined) {
          err(event.seq, `missing checkpoint body ${event.payload.checkpointId}`);
          break;
        }
        if (event.payload.sha256 && sha256Hex(text) !== event.payload.sha256) {
          err(event.seq, `checkpoint body hash mismatch ${event.payload.checkpointId}`);
        }
        if (event.payload.sha256 && utf8ByteLength(text) !== event.payload.byteLength) {
          err(event.seq, `checkpoint byte length mismatch ${event.payload.checkpointId}`);
        }
        doc.text = text;
        doc.version = event.payload.version;
        doc.sha256 = sha256Hex(text);
        break;
      }
      case "document.saved":
      case "document.closed":
      case "document.resumed":
      case "document.languageChanged": {
        if (!documents.has(event.payload.documentId)) {
          err(event.seq, `${event.type} for unknown document`);
        }
        break;
      }
      case "surface.opened": {
        if (!documents.has(event.payload.documentId)) {
          err(event.seq, "surface.opened for unknown document");
        }
        knownSurfaces.add(event.payload.surfaceId);
        break;
      }
      case "surface.closed":
      case "surface.focused":
      case "surface.selectionChanged":
      case "surface.viewportChanged": {
        if (!knownSurfaces.has(event.payload.surfaceId)) {
          err(event.seq, `${event.type} for unknown surface`);
        }
        break;
      }
      default:
        break;
    }
  }

  return { ok: errors.length === 0, errors, finalDocuments: documents };
}
