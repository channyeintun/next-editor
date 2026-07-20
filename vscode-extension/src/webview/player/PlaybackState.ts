// Pure playback state types (plan §10.3). Environment-neutral: no vscode,
// no node imports. The playback engine owns truth; renderers are
// projections (plan §11.1).
import type {
  ContentChange,
  EolMode,
  SelectionRange,
  TopologySnapshotPayload,
  VisibleLineRange,
} from "../../model/events";

export type PlaybackDocumentState = {
  documentId: string;
  text: string;
  version: number;
  eol: EolMode;
  languageId: string;
  displayName: string;
};

export type PlaybackSurfaceState = {
  surfaceId: string;
  documentId: string;
  groupId: string | null;
  viewColumn: number | null;
  selections: SelectionRange[];
  visibleRanges: VisibleLineRange[];
  open: boolean;
};

export type PlaybackSessionState = {
  timeUs: number;
  appliedSeq: number;
  documents: Map<string, PlaybackDocumentState>;
  surfaces: Map<string, PlaybackSurfaceState>;
  topology: TopologySnapshotPayload | null;
  activeSurfaceId: string | null;
};

export function createEmptySessionState(): PlaybackSessionState {
  return {
    timeUs: 0,
    appliedSeq: -1,
    documents: new Map(),
    surfaces: new Map(),
    topology: null,
    activeSurfaceId: null,
  };
}

export function applyContentChanges(text: string, changes: readonly ContentChange[]): string {
  let next = text;
  for (const change of changes) {
    if (
      change.rangeOffsetUtf16 < 0 ||
      change.rangeLengthUtf16 < 0 ||
      change.rangeOffsetUtf16 + change.rangeLengthUtf16 > next.length
    ) {
      throw new Error(
        `content change outside document bounds: ${change.rangeOffsetUtf16}+${change.rangeLengthUtf16} > ${next.length}`,
      );
    }
    next =
      next.slice(0, change.rangeOffsetUtf16) +
      change.text +
      next.slice(change.rangeOffsetUtf16 + change.rangeLengthUtf16);
  }
  return next;
}
