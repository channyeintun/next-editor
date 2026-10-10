import * as Y from "yjs";
import { MAX_YJS_SNAPSHOT_BYTES } from "./protocol";
import { getCollaborationProjectRoot, getOrCreateChildMap } from "./projectDocument";

// The room's teaching tree as the slides and whiteboard modules share it: the
// key names, the error type and the root accessors. teachingSlides and
// teachingWhiteboard import this module and never teachingDocument, which
// composes them into the seed, projection and validator.

export const COLLABORATION_TEACHING_ROOT = "teaching";
export const COLLABORATION_TEACHING_SLIDE_ORDER = "slideOrder";
export const COLLABORATION_TEACHING_SLIDES = "slides";
export const COLLABORATION_TEACHING_PRESENTATION = "presentation";
export const COLLABORATION_TEACHING_WHITEBOARD = "whiteboardElements";

export class CollaborationTeachingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollaborationTeachingError";
  }
}

export function optionalTeachingRoot(doc: Y.Doc): Y.Map<unknown> | null {
  const teaching = getCollaborationProjectRoot(doc).get(COLLABORATION_TEACHING_ROOT);
  return teaching instanceof Y.Map ? teaching : null;
}

export function getCollaborationTeachingRoot(doc: Y.Doc): Y.Map<unknown> {
  return getOrCreateChildMap(getCollaborationProjectRoot(doc), COLLABORATION_TEACHING_ROOT);
}

export function isCollaborationTeachingInitialized(doc: Y.Doc): boolean {
  return optionalTeachingRoot(doc)?.get("initialized") === true;
}

export function assertTeachingUpdateFitsSnapshot(doc: Y.Doc, additionalBytes: number): void {
  if (Y.encodeStateAsUpdate(doc).byteLength + additionalBytes > MAX_YJS_SNAPSHOT_BYTES) {
    throw new CollaborationTeachingError(
      "The shared teaching state exceeds the room snapshot limit",
    );
  }
}
