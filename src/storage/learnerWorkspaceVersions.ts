import type { LearnerWorkspaceSave } from "../core/src/machine/types";
import { areWorkspaceProjectsEqual, type WorkspaceRecordingSnapshot } from "../types/workspace";
import { requestToPromise, transactionToPromise } from "./idb";

/**
 * A viewer's own edits to a lesson, kept on this device. The machine hands them over
 * (`onLearnerWorkspaceSaved`) whenever the recording is about to take the workspace
 * back — resume, scrub, stop, leaving the page — so pressing Play never loses work.
 *
 * Keyed by the recording's id, which the .ne file carries, so the same lesson opened
 * again finds its versions. Binary files are asset descriptors whose bytes already
 * live in the workspace asset store, so a version holds only text and references.
 */
export interface LearnerWorkspaceVersion {
  id: string;
  recordingId: string;
  /** Where in the lesson the edits were made (ms). */
  recordingTime: number;
  /** When they were last saved (epoch ms). */
  savedAt: number;
  snapshot: WorkspaceRecordingSnapshot;
}

/** Versions kept per lesson; the oldest is dropped past this. */
export const MAX_LEARNER_VERSIONS_PER_RECORDING = 10;

const DATABASE_NAME = "next-editor-learner-workspaces-db";
const DATABASE_VERSION = 1;
const VERSION_STORE = "versions";
const RECORDING_INDEX = "recordingId";

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(VERSION_STORE)) {
        const store = database.createObjectStore(VERSION_STORE, { keyPath: "id" });
        store.createIndex(RECORDING_INDEX, "recordingId", { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("Failed to open the learner workspace database"));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("Learner workspace database upgrade is blocked"));
    };
  });
}

function getDatabase(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === "undefined") return null;
  databasePromise ??= openDatabase(indexedDB);
  return databasePromise;
}

/** Newest first. */
function byNewest(left: LearnerWorkspaceVersion, right: LearnerWorkspaceVersion): number {
  return right.savedAt - left.savedAt;
}

async function readVersions(
  database: IDBDatabase,
  recordingId: string,
): Promise<LearnerWorkspaceVersion[]> {
  const transaction = database.transaction(VERSION_STORE, "readonly");
  const versions = await requestToPromise<LearnerWorkspaceVersion[]>(
    transaction.objectStore(VERSION_STORE).index(RECORDING_INDEX).getAll(recordingId),
  );
  return versions.sort(byNewest);
}

export async function listLearnerWorkspaceVersions(
  recordingId: string,
): Promise<LearnerWorkspaceVersion[]> {
  const databaseResult = getDatabase();
  if (!databaseResult) return [];
  return readVersions(await databaseResult, recordingId);
}

function createVersionId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Keeps `save` and returns the lesson's versions, newest first. Saving the same files
 * as the newest version (edits restored and resumed unchanged) refreshes that version
 * instead of adding a copy.
 */
export async function saveLearnerWorkspaceVersion(
  save: LearnerWorkspaceSave,
  now: number = Date.now(),
): Promise<LearnerWorkspaceVersion[]> {
  const databaseResult = getDatabase();
  if (!databaseResult) return [];
  const database = await databaseResult;

  const existing = await readVersions(database, save.recordingId);
  const newest = existing[0];
  const version: LearnerWorkspaceVersion =
    newest && areWorkspaceProjectsEqual(newest.snapshot.project, save.snapshot.project)
      ? { ...newest, recordingTime: save.recordingTime, savedAt: now, snapshot: save.snapshot }
      : {
          id: createVersionId(),
          recordingId: save.recordingId,
          recordingTime: save.recordingTime,
          savedAt: now,
          snapshot: save.snapshot,
        };
  const versions = [version, ...existing.filter((entry) => entry.id !== version.id)];
  const dropped = versions.slice(MAX_LEARNER_VERSIONS_PER_RECORDING);

  const transaction = database.transaction(VERSION_STORE, "readwrite");
  const complete = transactionToPromise(transaction);
  const store = transaction.objectStore(VERSION_STORE);
  store.put(version);
  for (const entry of dropped) store.delete(entry.id);
  await complete;

  return versions.slice(0, MAX_LEARNER_VERSIONS_PER_RECORDING);
}

export async function deleteLearnerWorkspaceVersion(id: string): Promise<void> {
  const databaseResult = getDatabase();
  if (!databaseResult) return;
  const transaction = (await databaseResult).transaction(VERSION_STORE, "readwrite");
  const complete = transactionToPromise(transaction);
  transaction.objectStore(VERSION_STORE).delete(id);
  await complete;
}

export function resetLearnerWorkspaceVersionsForTests(): void {
  databasePromise = null;
}
