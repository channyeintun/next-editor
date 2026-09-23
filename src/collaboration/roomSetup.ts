// Room creation and teaching-surface initialization over the room REST API.
// Plain async functions: CollaborationContext supplies the workspace and the
// standalone deck/whiteboard snapshots and keeps the React state.
import * as Y from "yjs";
import {
  closeCollaborationRoom,
  createCollaborationRoom,
  initializeCollaborationTeachingSurfaces,
  uploadCollaborationAsset,
} from "@next-editor/infra";
import type { WhiteboardSceneState } from "../core/src/whiteboard";
import { getWorkspaceAssetBytes } from "../storage/workspaceAssetStore";
import type { Slide } from "../types/slides";
import { isWorkspaceAssetFile, type WorkspaceProject } from "../types/workspace";
import { seedCollaborationProject } from "./projectDocument";
import {
  MAX_COLLABORATION_ROOM_ASSETS,
  MAX_COLLABORATION_ROOM_ASSET_BYTES,
  type CollaborationRoomSession,
} from "./protocol";
import { requestErrorStatus } from "./roomProvider";
import {
  COLLABORATION_SLIDE_ASSET_MIME_TYPE,
  collaborationSlidePayloadAssetId,
  normalizeCollaborationTeachingSlides,
  seedCollaborationTeachingDocument,
} from "./teachingDocument";
import {
  createCollaborationRoomSnapshot,
  createCollaborationTeachingInitialization,
} from "./yjsUpdates";

function isRetryableTeachingInitializationError(error: unknown): boolean {
  const status = requestErrorStatus(error);
  return status === null || status === 429 || status >= 500;
}

interface CollaborationTeachingAssetPlan {
  items: Array<{ slide: Slide; payload: Uint8Array; assetId: string }>;
  assets: Map<string, { id: string; payload: Uint8Array; mimeType: string }>;
}

async function createCollaborationTeachingAssetPlan(
  slides: readonly Slide[],
): Promise<CollaborationTeachingAssetPlan> {
  const normalized = normalizeCollaborationTeachingSlides(slides);
  const items: CollaborationTeachingAssetPlan["items"] = [];
  const assets: CollaborationTeachingAssetPlan["assets"] = new Map();
  for (const item of normalized) {
    const assetId = await collaborationSlidePayloadAssetId(item.payload);
    const existing = assets.get(assetId);
    if (
      existing &&
      (existing.payload.byteLength !== item.payload.byteLength ||
        !existing.payload.every((byte, index) => byte === item.payload[index]))
    ) {
      throw new Error("Distinct teaching payloads produced the same content digest.");
    }
    if (!existing) {
      assets.set(assetId, {
        id: assetId,
        payload: item.payload,
        mimeType: COLLABORATION_SLIDE_ASSET_MIME_TYPE,
      });
    }
    items.push({ ...item, assetId });
  }
  return { items, assets };
}

/**
 * Uploads the deck's slide assets and publishes the room's teaching subtree
 * (deck manifest, current slide and whiteboard seed) as one update on top of
 * `baseDoc`.
 */
export async function publishCollaborationTeachingInitialization(
  targetRoomId: string,
  baseDoc: Y.Doc,
  slides: readonly Slide[],
  whiteboard: WhiteboardSceneState,
  clientId: string,
  preparedPlan?: CollaborationTeachingAssetPlan,
): Promise<void> {
  const plan = preparedPlan ?? (await createCollaborationTeachingAssetPlan(slides));
  const uniqueAssets = Array.from(plan.assets.values());
  const totalPayloadBytes = uniqueAssets.reduce(
    (total, asset) => total + asset.payload.byteLength,
    0,
  );
  if (uniqueAssets.length > MAX_COLLABORATION_ROOM_ASSETS) {
    throw new Error("The room presentation contains too many slide assets.");
  }
  if (totalPayloadBytes > MAX_COLLABORATION_ROOM_ASSET_BYTES) {
    throw new Error("The room presentation exceeds the shared asset quota.");
  }

  const uploadedAssets = new Map<string, Awaited<ReturnType<typeof uploadCollaborationAsset>>>();
  for (const item of uniqueAssets) {
    const asset = await uploadCollaborationAsset(targetRoomId, item.payload, item.mimeType);
    if (asset.id !== item.id || asset.size !== item.payload.byteLength) {
      throw new Error("An uploaded teaching asset did not match its source payload.");
    }
    uploadedAssets.set(item.id, asset);
  }
  const uploaded = plan.items.map((item) => {
    const asset = uploadedAssets.get(item.assetId);
    if (!asset) throw new Error("An uploaded teaching asset is missing from the snapshot.");
    return { slide: item.slide, asset };
  });

  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(baseDoc));
    const stateVector = Y.encodeStateVector(candidate);
    seedCollaborationTeachingDocument(candidate, {
      slides: uploaded,
      whiteboardElements: whiteboard.elements,
    });
    const update = Y.encodeStateAsUpdate(candidate, stateVector);
    const initialization = createCollaborationTeachingInitialization(update, clientId);
    try {
      await initializeCollaborationTeachingSurfaces(targetRoomId, initialization);
    } catch (error) {
      // The endpoint is idempotent for this exact update. One bounded retry
      // covers a lost response without exposing a partially initialized room.
      if (!isRetryableTeachingInitializationError(error)) throw error;
      await initializeCollaborationTeachingSurfaces(targetRoomId, initialization);
    }
  } finally {
    candidate.destroy();
  }
}

/**
 * Creates a room seeded with `project`, uploads its binary assets and the
 * standalone deck, and publishes the teaching surfaces. A failure after the
 * room exists closes it again.
 */
export async function createCollaborationRoomFromWorkspace({
  project,
  slides,
  whiteboard,
}: {
  project: WorkspaceProject;
  slides: readonly Slide[];
  whiteboard: WhiteboardSceneState;
}): Promise<CollaborationRoomSession> {
  const teachingAssetPlan = await createCollaborationTeachingAssetPlan(slides);
  const binaryFiles = Object.values(project.files)
    .filter(isWorkspaceAssetFile)
    .sort((left, right) => left.path.localeCompare(right.path));
  const uniqueWorkspaceAssets = new Map<string, { mimeType: string; size: number }>();
  for (const file of binaryFiles) {
    const existing = uniqueWorkspaceAssets.get(file.content.assetId);
    if (
      existing &&
      (existing.mimeType !== file.content.mimeType || existing.size !== file.content.size)
    ) {
      throw new Error("Duplicate workspace assets have conflicting metadata.");
    }
    uniqueWorkspaceAssets.set(file.content.assetId, {
      mimeType: file.content.mimeType,
      size: file.content.size,
    });
  }
  const prospectiveAssets = new Map(uniqueWorkspaceAssets);
  for (const asset of teachingAssetPlan.assets.values()) {
    const existing = prospectiveAssets.get(asset.id);
    if (
      existing &&
      (existing.mimeType !== asset.mimeType || existing.size !== asset.payload.byteLength)
    ) {
      throw new Error("Workspace and teaching assets have conflicting digest metadata.");
    }
    prospectiveAssets.set(asset.id, {
      mimeType: asset.mimeType,
      size: asset.payload.byteLength,
    });
  }
  const prospectiveAssetCount = prospectiveAssets.size;
  const prospectiveAssetBytes = Array.from(prospectiveAssets.values()).reduce(
    (total, asset) => total + asset.size,
    0,
  );
  if (prospectiveAssetCount > MAX_COLLABORATION_ROOM_ASSETS) {
    throw new Error(`A live room can contain at most ${MAX_COLLABORATION_ROOM_ASSETS} assets.`);
  }
  if (prospectiveAssetBytes > MAX_COLLABORATION_ROOM_ASSET_BYTES) {
    throw new Error("The project and presentation exceed the live room asset quota.");
  }
  const doc = new Y.Doc();
  seedCollaborationProject(doc, project);
  const clientId = crypto.randomUUID();
  let created: CollaborationRoomSession;
  try {
    created = await createCollaborationRoom(createCollaborationRoomSnapshot(doc, clientId));
  } catch (error) {
    doc.destroy();
    throw error;
  }
  try {
    const uploadedWorkspaceAssetIds = new Set<string>();
    for (const file of binaryFiles) {
      if (uploadedWorkspaceAssetIds.has(file.content.assetId)) continue;
      const bytes = await getWorkspaceAssetBytes(file.content);
      const asset = await uploadCollaborationAsset(created.room.id, bytes, file.content.mimeType);
      if (
        asset.id !== file.content.assetId ||
        asset.mimeType !== file.content.mimeType ||
        asset.size !== file.content.size
      ) {
        throw new Error(`Uploaded collaboration asset did not match ${file.path}`);
      }
      uploadedWorkspaceAssetIds.add(asset.id);
    }
    await publishCollaborationTeachingInitialization(
      created.room.id,
      doc,
      slides,
      whiteboard,
      clientId,
      teachingAssetPlan,
    );
    return created;
  } catch (error) {
    await closeCollaborationRoom(created.room.id).catch(() => {});
    throw error;
  } finally {
    doc.destroy();
  }
}
