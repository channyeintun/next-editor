// Persists across the full-page OAuth redirect (see docs/upload-modal-ux-spec.md's
// "signed-out flow"). Uses its own tiny IndexedDB store rather than
// localStorage/sessionStorage — the recording itself already lives in
// IndexedDB, so this keeps everything in one storage system. Self-contained
// rather than reusing src/storage/idb.ts (that's internal plumbing for the
// recording/workspace stores specifically, not a general-purpose export) —
// a single-key get/set/delete doesn't need shared infrastructure.

export interface ResumeIntent {
  recordingId: string;
  returnTo: string;
  /**
   * Only set when a session expired mid-form (see the spec) — the
   * signed-out entry state has no form fields yet, so that's the only case
   * where typed values need to survive the redirect.
   */
  draft?: {
    title: string;
    description: string;
    tags: string;
  };
}

const DB_NAME = "next-editor-tube-resume";
const STORE_NAME = "intent";
const KEY = "current";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open resume-intent store"));
  });
}

export async function saveResumeIntent(intent: ResumeIntent): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(intent, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to save resume intent"));
    });
  } finally {
    db.close();
  }
}

export async function loadResumeIntent(): Promise<ResumeIntent | null> {
  const db = await openDb();
  try {
    const result = await new Promise<ResumeIntent | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(KEY);
      request.onsuccess = () => resolve(request.result as ResumeIntent | undefined);
      request.onerror = () => reject(request.error ?? new Error("Failed to load resume intent"));
    });
    return result ?? null;
  } finally {
    db.close();
  }
}

// Used once — always cleared after being read, whether or not it was acted on.
export async function clearResumeIntent(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to clear resume intent"));
    });
  } finally {
    db.close();
  }
}
