import { createStore } from "@xstate/store-react";
import type { LearnerWorkspaceSave } from "../core/src/machine/types";
import {
  deleteLearnerWorkspaceVersion,
  listLearnerWorkspaceVersions,
  saveLearnerWorkspaceVersion,
  type LearnerWorkspaceVersion,
} from "../storage/learnerWorkspaceVersions";

// The open lesson's saved learner versions (see learnerWorkspaceVersions.ts), for the
// player's "Your edits" menu. IndexedDB is the source of truth; this mirrors the one
// lesson on screen so the menu can render synchronously.

export interface LearnerVersionsContext {
  recordingId: string | null;
  /** Newest first. */
  versions: LearnerWorkspaceVersion[];
  /** When the machine last saved edits for this lesson, so the menu can say so. */
  lastSavedAt: number | null;
}

function createLearnerVersionsStore() {
  return createStore({
    context: { recordingId: null, versions: [], lastSavedAt: null } as LearnerVersionsContext,
    on: {
      opened: (context, event: { recordingId: string | null }) =>
        event.recordingId === context.recordingId
          ? context
          : { recordingId: event.recordingId, versions: [], lastSavedAt: null },
      // Every result is checked against the open lesson: a slow read for the lesson
      // just left must not land on the next one.
      loaded: (context, event: { recordingId: string; versions: LearnerWorkspaceVersion[] }) =>
        event.recordingId === context.recordingId
          ? { ...context, versions: event.versions }
          : context,
      saved: (
        context,
        event: { recordingId: string; versions: LearnerWorkspaceVersion[]; savedAt: number },
      ) =>
        event.recordingId === context.recordingId
          ? { ...context, versions: event.versions, lastSavedAt: event.savedAt }
          : context,
      removed: (context, event: { id: string }) => ({
        ...context,
        versions: context.versions.filter((version) => version.id !== event.id),
      }),
    },
  });
}

export type LearnerVersionsStoreInstance = ReturnType<typeof createLearnerVersionsStore>;

let learnerVersionsStore: LearnerVersionsStoreInstance | null = null;

export function getLearnerVersionsStore(): LearnerVersionsStoreInstance {
  learnerVersionsStore ??= createLearnerVersionsStore();
  return learnerVersionsStore;
}

/** Points the store at the lesson now on screen and loads its versions. */
export async function openLearnerVersions(recordingId: string | null): Promise<void> {
  const store = getLearnerVersionsStore();
  store.trigger.opened({ recordingId });
  if (!recordingId) return;
  try {
    const versions = await listLearnerWorkspaceVersions(recordingId);
    store.trigger.loaded({ recordingId, versions });
  } catch (error) {
    console.warn("Could not read your saved edits for this lesson:", error);
  }
}

/** The machine's `onLearnerWorkspaceSaved`: keep the edits, then show them in the menu. */
export async function keepLearnerWorkspace(save: LearnerWorkspaceSave): Promise<void> {
  const savedAt = Date.now();
  try {
    const versions = await saveLearnerWorkspaceVersion(save, savedAt);
    getLearnerVersionsStore().trigger.saved({ recordingId: save.recordingId, versions, savedAt });
  } catch (error) {
    console.warn("Could not save your edits for this lesson:", error);
  }
}

export async function forgetLearnerVersion(id: string): Promise<void> {
  getLearnerVersionsStore().trigger.removed({ id });
  try {
    await deleteLearnerWorkspaceVersion(id);
  } catch (error) {
    console.warn("Could not delete a saved version of your edits:", error);
  }
}

export function resetLearnerVersionsStoreForTests(): void {
  learnerVersionsStore = null;
}
