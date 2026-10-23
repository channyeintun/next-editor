import { createDatabaseOpener, requestToPromise, transactionToPromise } from "../../storage/idb";
import { isStudioWorkflow, type StudioWorkflow } from "./workflowQueue";

/**
 * Where a studio workflow survives a reload: the queue in localStorage, its
 * picked thumbnails in IndexedDB (a File cannot go through JSON). A stopped
 * workflow resumes from here after Chan reloads the page with a fix — the
 * thumbnails would otherwise have to be picked again.
 */

const WORKFLOW_KEY = "next-editor:studio:workflow:v1";

export function loadStoredWorkflow(): StudioWorkflow | null {
  try {
    const raw = localStorage.getItem(WORKFLOW_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStudioWorkflow(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function storeWorkflow(workflow: StudioWorkflow | null): void {
  try {
    if (workflow) {
      localStorage.setItem(WORKFLOW_KEY, JSON.stringify(workflow));
    } else {
      localStorage.removeItem(WORKFLOW_KEY);
    }
  } catch {
    // Storage unavailable or full: the workflow still runs, it just cannot
    // resume after a reload.
  }
}

const STORE = "thumbnails";

interface StoredThumbnail {
  slug: string;
  file: File;
}

const database = createDatabaseOpener({
  name: "next-editor-studio-workflow",
  version: 1,
  upgrade: (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: "slug" });
    }
  },
  openError: "Could not open the studio workflow's thumbnail store",
  blockedError: "The studio workflow's thumbnail store is open in another tab",
});

/** Replace the stored thumbnails with a new workflow's, by lesson slug. */
export async function storeWorkflowThumbnails(
  thumbnails: ReadonlyMap<string, File>,
): Promise<void> {
  const db = await database.open(indexedDB);
  const transaction = db.transaction(STORE, "readwrite");
  const store = transaction.objectStore(STORE);
  store.clear();
  for (const [slug, file] of thumbnails) {
    store.put({ slug, file } satisfies StoredThumbnail);
  }
  await transactionToPromise(transaction);
}

export async function loadWorkflowThumbnail(slug: string): Promise<File | null> {
  const db = await database.open(indexedDB);
  const stored = await requestToPromise<StoredThumbnail | undefined>(
    db.transaction(STORE, "readonly").objectStore(STORE).get(slug),
  );
  return stored?.file ?? null;
}

export async function clearWorkflowThumbnails(): Promise<void> {
  const db = await database.open(indexedDB);
  const transaction = db.transaction(STORE, "readwrite");
  transaction.objectStore(STORE).clear();
  await transactionToPromise(transaction);
}
