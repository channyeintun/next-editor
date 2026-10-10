import type {
  InitializedWorkspaceState,
  StoredWorkspaceSnapshot,
  WorkspaceStoreInstance,
} from "./workspaceStore";
import {
  normalizeProject,
  resolveActiveFilePath,
  withMigratedAssetDescriptors,
} from "./workspaceProjectSupport";
import { createStarterWorkspaceProject } from "../starters/react";
import {
  migrateLegacyWorkspaceAssets,
  persistWorkspaceAssets,
  pruneLegacyWorkspaceAssetKeys,
} from "../storage/workspaceAssetStore";
import {
  isLegacyWorkspaceBinaryFile,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../types/workspace";
import { normalizeWorkspacePath } from "../types/workspacePaths";
import { isNextEditorUrl, resolveRecordingUrl } from "../utils/recordingUrl";

export const WORKSPACE_STORAGE_KEY = "next-editor-workspace";

/**
 * Asset descriptors are already lightweight and JSON-serializable. Only legacy
 * inline base64 entries are stripped while a v1 snapshot is being migrated.
 */
export function toPersistedSnapshot(snapshot: StoredWorkspaceSnapshot): StoredWorkspaceSnapshot {
  let strippedAny = false;
  const files: Record<string, WorkspaceFile> = {};

  for (const [path, file] of Object.entries(snapshot.project.files)) {
    if (isLegacyWorkspaceBinaryFile(file) && file.content !== "") {
      files[path] = { ...file, content: "" };
      strippedAny = true;
    } else {
      files[path] = file;
    }
  }

  if (!strippedAny) {
    return snapshot;
  }

  return {
    ...snapshot,
    project: { ...snapshot.project, files },
  };
}

function loadStoredWorkspaceSnapshot(): StoredWorkspaceSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);

    if (!stored) {
      return null;
    }

    const parsed = JSON.parse(stored) as StoredWorkspaceSnapshot;
    const project = normalizeProject(parsed.project);
    const activeFilePath = resolveActiveFilePath(
      project,
      normalizeWorkspacePath(parsed.activeFilePath ?? ""),
    );

    // Sidebar width is deliberately not restored from storage; it resets to the
    // default on every reload (see sidebarLayout.ts).
    return {
      activeFilePath,
      project,
      assetGeneration:
        typeof parsed.assetGeneration === "string" ? parsed.assetGeneration : undefined,
    };
  } catch (error) {
    console.warn("Failed to load workspace snapshot:", error);
    return null;
  }
}

/**
 * Whether `?url=` names a `.ne`, read exactly as useUrlQuery reads it and
 * checked exactly as the loader checks it before loading it.
 */
function hasPendingRecordingUrl(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const url = resolveRecordingUrl(new URLSearchParams(window.location.search).get("url"));
  return url !== null && isNextEditorUrl(url);
}

/**
 * `pendingRecordingUrl` is how a surface that loads a recording from a prop
 * rather than `?url=` — the /learn/:slug detail view — declares that its real
 * content is still in flight. Without it, the persisted workspace wins the
 * race and the editor mounts showing the *previous* session's files until the
 * `.ne` lands and replaces them. Sniffing the query string can't see that case:
 * a lesson URL carries no `url` param at all.
 */
export function createInitialWorkspaceSnapshot(
  pendingRecordingUrl?: string,
): StoredWorkspaceSnapshot | null {
  if (pendingRecordingUrl || hasPendingRecordingUrl()) {
    return null;
  }

  const storedSnapshot = loadStoredWorkspaceSnapshot();

  if (storedSnapshot) {
    return storedSnapshot;
  }

  const project = createStarterWorkspaceProject();
  return {
    activeFilePath: project.entryFilePath,
    project,
  };
}

/**
 * Makes one workspace generation durable: the assets first, then the
 * localStorage metadata that references them. A failure leaves the workspace
 * dirty and is reported through the store.
 */
export async function persistWorkspace(
  workspaceStore: WorkspaceStoreInstance,
  { activeFilePath, project, savedSnapshot, workspaceLoadVersion }: InitializedWorkspaceState,
): Promise<void> {
  workspaceStore.trigger.beginSave({ workspaceLoadVersion });

  try {
    const migratedDescriptors = await migrateLegacyWorkspaceAssets(
      project,
      savedSnapshot.assetGeneration,
    );
    const storedFiles = withMigratedAssetDescriptors(project.files, migratedDescriptors);
    const storedProject: WorkspaceProject =
      storedFiles === project.files ? project : { ...project, files: storedFiles };
    if (Object.keys(migratedDescriptors).length > 0) {
      workspaceStore.trigger.hydrateAssetDescriptors({ descriptors: migratedDescriptors });
    }
    await persistWorkspaceAssets(storedProject);

    // Capture the exact durable project generation. Edits arriving while
    // this save is in flight remain dirty against this snapshot.
    const storedSnapshot = {
      activeFilePath,
      project: storedProject,
    } satisfies StoredWorkspaceSnapshot;

    // Publish metadata only after every referenced asset is durable.
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify(toPersistedSnapshot(storedSnapshot)),
    );
    workspaceStore.trigger.markSaved({
      snapshot: storedSnapshot,
      workspaceLoadVersion,
    });

    void pruneLegacyWorkspaceAssetKeys().catch((error) => {
      console.warn("Failed to prune old workspace assets:", error);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The workspace could not be saved";
    workspaceStore.trigger.saveFailed({ message, workspaceLoadVersion });
    console.warn("Failed to save workspace snapshot:", error);
  }
}
