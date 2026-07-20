// Deterministic event reducer (plan §10.3): the same code path runs in
// Node unit tests and in the webview player/benchmark.
import type { SessionEvent } from "../../model/events";
import {
  applyContentChanges,
  createEmptySessionState,
  type PlaybackSessionState,
} from "./PlaybackState";

export type ReducerIssue = {
  seq: number;
  type: string;
  message: string;
};

export class SessionReducer {
  readonly state: PlaybackSessionState = createEmptySessionState();
  readonly issues: ReducerIssue[] = [];
  // Checkpoint text lookup supplied by the container (plan §9.5 keeps
  // checkpoint bodies outside the event stream).
  constructor(private readonly checkpointText: (checkpointId: string) => string | undefined) {}

  apply(event: SessionEvent): void {
    const { state } = this;
    if (event.seq <= state.appliedSeq) {
      this.issues.push({
        seq: event.seq,
        type: event.type,
        message: "event replayed out of order",
      });
      return;
    }
    state.appliedSeq = event.seq;
    state.timeUs = event.tUs;

    switch (event.type) {
      case "document.enrolled": {
        const d = event.payload.descriptor;
        if (state.documents.has(d.documentId)) {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: `duplicate document enrollment ${d.documentId}`,
          });
          break;
        }
        const text = this.checkpointText(d.initialCheckpointId);
        state.documents.set(d.documentId, {
          documentId: d.documentId,
          text: text ?? "",
          version: d.initialVersion,
          eol: d.eol,
          languageId: d.languageId,
          displayName: d.displayName,
        });
        if (text === undefined) {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: `missing checkpoint ${d.initialCheckpointId}`,
          });
        }
        break;
      }
      case "document.patch": {
        const doc = state.documents.get(event.payload.documentId);
        if (!doc) {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: "patch for unknown document",
          });
          break;
        }
        if (event.payload.beforeVersion !== doc.version) {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: `version mismatch: patch before=${event.payload.beforeVersion}, state=${doc.version}`,
          });
          break;
        }
        try {
          doc.text = applyContentChanges(doc.text, event.payload.changes);
          doc.version = event.payload.afterVersion;
          doc.eol = event.payload.eolAfter;
        } catch (error) {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case "document.checkpoint": {
        const doc = state.documents.get(event.payload.documentId);
        const text = this.checkpointText(event.payload.checkpointId);
        if (!doc) {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: "checkpoint for unknown document",
          });
        } else if (text !== undefined) {
          doc.text = text;
          doc.version = event.payload.version;
          doc.eol = event.payload.eol;
        } else if (
          event.payload.reason === "resume" ||
          event.payload.reason === "mismatch" ||
          event.payload.reason === "limit"
        ) {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: `missing state checkpoint ${event.payload.checkpointId}`,
          });
        }
        break;
      }
      case "document.languageChanged": {
        const doc = state.documents.get(event.payload.documentId);
        if (doc) {
          doc.languageId = event.payload.languageId;
        } else {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: "language change for unknown document",
          });
        }
        break;
      }
      case "document.resumed": {
        const doc = state.documents.get(event.payload.documentId);
        if (doc) {
          doc.version = event.payload.version;
        } else {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: "resume for unknown document",
          });
        }
        break;
      }
      case "document.eolChanged": {
        const doc = state.documents.get(event.payload.documentId);
        if (doc) {
          doc.text = doc.text.replace(/\r\n|\r|\n/g, event.payload.eol === "CRLF" ? "\r\n" : "\n");
          doc.version = event.payload.version;
          doc.eol = event.payload.eol;
        } else {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: "EOL change for unknown document",
          });
        }
        break;
      }
      case "document.saved":
      case "document.closed": {
        if (!state.documents.has(event.payload.documentId)) {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: `${event.type} for unknown document`,
          });
        }
        break;
      }
      case "surface.opened": {
        if (!state.documents.has(event.payload.documentId)) {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: "surface opened for unknown document",
          });
          break;
        }
        state.surfaces.set(event.payload.surfaceId, {
          surfaceId: event.payload.surfaceId,
          documentId: event.payload.documentId,
          groupId: event.payload.groupId,
          viewColumn: event.payload.viewColumn,
          selections: event.payload.selections,
          visibleRanges: event.payload.visibleRanges,
          open: true,
        });
        if (event.payload.isActive) {
          state.activeSurfaceId = event.payload.surfaceId;
        }
        break;
      }
      case "surface.closed": {
        const surface = state.surfaces.get(event.payload.surfaceId);
        if (surface) {
          surface.open = false;
        } else {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: "close for unknown surface",
          });
        }
        if (state.activeSurfaceId === event.payload.surfaceId) {
          state.activeSurfaceId = null;
        }
        break;
      }
      case "surface.focused": {
        if (state.surfaces.has(event.payload.surfaceId)) {
          state.activeSurfaceId = event.payload.surfaceId;
        } else {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: "focus for unknown surface",
          });
        }
        break;
      }
      case "surface.selectionChanged": {
        const surface = state.surfaces.get(event.payload.surfaceId);
        if (surface && surface.documentId === event.payload.documentId) {
          surface.selections = event.payload.selections;
        } else {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: "selection for unknown or mismatched surface",
          });
        }
        break;
      }
      case "surface.viewportChanged": {
        const surface = state.surfaces.get(event.payload.surfaceId);
        if (surface && surface.documentId === event.payload.documentId) {
          surface.visibleRanges = event.payload.visibleRanges;
        } else {
          this.issues.push({
            seq: event.seq,
            type: event.type,
            message: "viewport for unknown or mismatched surface",
          });
        }
        break;
      }
      case "topology.snapshot": {
        state.topology = event.payload;
        break;
      }
      // Session-level, audio, and marker events do not change visual
      // document/surface state in the reducer.
      case "session.started":
      case "session.stopping":
      case "session.finalized":
      case "session.recovered":
      case "session.failed":
      case "roots.snapshot":
      case "window.focusChanged":
      case "capability.unsupportedSurface":
      case "capture.overload":
      case "capture.shadowMismatch":
      case "audio.started":
      case "audio.calibration":
      case "audio.discontinuity":
      case "audio.stopped":
      case "marker":
        break;
      default: {
        // Unknown event types must not execute code (plan §7.9).
        this.issues.push({
          seq: (event as SessionEvent).seq,
          type: (event as SessionEvent).type,
          message: "unknown event type ignored",
        });
        break;
      }
    }
  }
}
