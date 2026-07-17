import type { Recording } from "../core/src";
import {
  isWorkspaceAssetDescriptor,
  isWorkspaceAssetFile,
  type WorkspaceAssetDescriptor,
  type WorkspaceRecordingAsset,
  type WorkspaceRecordingEvent,
  type WorkspaceRecordingSnapshot,
} from "../types/workspace";
import { getWorkspaceAssetBytes, registerWorkspaceAsset } from "./workspaceAssetStore";

function descriptorsMatch(
  left: WorkspaceAssetDescriptor,
  right: WorkspaceAssetDescriptor,
): boolean {
  return (
    left.assetId === right.assetId &&
    left.mimeType === right.mimeType &&
    left.size === right.size
  );
}

function collectSnapshotDescriptors(
  snapshot: WorkspaceRecordingSnapshot | undefined,
  descriptors: Map<string, WorkspaceAssetDescriptor>,
): void {
  if (!snapshot) return;

  for (const file of Object.values(snapshot.project.files)) {
    if (!isWorkspaceAssetFile(file)) continue;
    const existing = descriptors.get(file.content.assetId);
    if (existing && !descriptorsMatch(existing, file.content)) {
      throw new Error(`Workspace asset ${file.content.assetId} has conflicting descriptors`);
    }
    descriptors.set(file.content.assetId, file.content);
  }
}

export function collectRecordingWorkspaceAssetDescriptors(
  recording: Pick<Recording, "workspaceEvents" | "workspaceSnapshot">,
): WorkspaceAssetDescriptor[] {
  const descriptors = new Map<string, WorkspaceAssetDescriptor>();
  collectSnapshotDescriptors(recording.workspaceSnapshot, descriptors);
  for (const event of recording.workspaceEvents ?? []) {
    collectSnapshotDescriptors(event.snapshot, descriptors);
  }
  return Array.from(descriptors.values());
}

export function collectWorkspaceEventAssetDescriptors(
  records: ReadonlyArray<unknown>,
): WorkspaceAssetDescriptor[] {
  const descriptors = new Map<string, WorkspaceAssetDescriptor>();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const snapshot = (record as Partial<WorkspaceRecordingEvent>).snapshot;
    if (!snapshot || typeof snapshot !== "object" || !("project" in snapshot)) continue;
    collectSnapshotDescriptors(snapshot as WorkspaceRecordingSnapshot, descriptors);
  }
  return Array.from(descriptors.values());
}

export async function* iterateRecordingWorkspaceAssets(
  recording: Recording,
): AsyncGenerator<WorkspaceRecordingAsset> {
  const descriptors = collectRecordingWorkspaceAssetDescriptors(recording);
  const supplied = new Map<string, WorkspaceRecordingAsset>();
  for (const asset of recording.workspaceAssets ?? []) {
    if (
      !isWorkspaceAssetDescriptor(asset.descriptor) ||
      !(asset.bytes instanceof Uint8Array) ||
      asset.bytes.byteLength !== asset.descriptor.size
    ) {
      throw new Error("Recording contains an invalid workspace asset payload");
    }
    const duplicate = supplied.get(asset.descriptor.assetId);
    if (duplicate && !descriptorsMatch(duplicate.descriptor, asset.descriptor)) {
      throw new Error(`Workspace asset ${asset.descriptor.assetId} has conflicting descriptors`);
    }
    supplied.set(asset.descriptor.assetId, asset);
  }

  for (const descriptor of descriptors) {
    const existing = supplied.get(descriptor.assetId);
    if (existing) {
      if (!descriptorsMatch(existing.descriptor, descriptor)) {
        throw new Error(`Workspace asset ${descriptor.assetId} has conflicting descriptors`);
      }
      yield existing;
      continue;
    }
    yield {
      descriptor,
      bytes: await getWorkspaceAssetBytes(descriptor),
    };
  }
}

export async function persistDecodedWorkspaceAssets(
  assets: ReadonlyArray<WorkspaceRecordingAsset> | undefined,
): Promise<void> {
  for (const asset of assets ?? []) {
    if (
      !isWorkspaceAssetDescriptor(asset.descriptor) ||
      !(asset.bytes instanceof Uint8Array) ||
      asset.bytes.byteLength !== asset.descriptor.size
    ) {
      throw new Error("Recording contains an invalid workspace asset payload");
    }
    await registerWorkspaceAsset(asset.bytes, {
      mimeType: asset.descriptor.mimeType,
      expectedAssetId: asset.descriptor.assetId,
    });
  }
}

export function stripRecordingWorkspaceAssets(recording: Recording): Recording {
  if (!recording.workspaceAssets) return recording;
  const { workspaceAssets: _workspaceAssets, ...withoutAssets } = recording;
  return withoutAssets;
}

export async function hydrateDecodedRecordingWorkspaceAssets(
  recording: Recording,
): Promise<Recording> {
  await persistDecodedWorkspaceAssets(recording.workspaceAssets);
  return stripRecordingWorkspaceAssets(recording);
}
