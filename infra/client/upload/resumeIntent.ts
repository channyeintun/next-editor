// Persists across the full-page OAuth redirect (see docs/upload-modal-ux-spec.md's
// "signed-out flow"). Uses its own tiny IndexedDB store rather than
// localStorage/sessionStorage — the upload modal stores the recording itself in
// IndexedDB right before this pointer, so this keeps everything in one storage
// system. It opens and closes its own database per call, and shares
// src/storage/idb.ts's request/transaction promise wrappers.

import { requestToPromise, transactionToPromise } from "@app/storage/idb";

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
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(intent, KEY);
    await transactionToPromise(tx);
  } finally {
    db.close();
  }
}

export async function loadResumeIntent(): Promise<ResumeIntent | null> {
  const db = await openDb();
  try {
    const result = await requestToPromise<ResumeIntent | undefined>(
      db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(KEY),
    );
    return result ?? null;
  } finally {
    db.close();
  }
}

// Used once — always cleared after being read, whether or not it was acted on.
export async function clearResumeIntent(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(KEY);
    await transactionToPromise(tx);
  } finally {
    db.close();
  }
}
