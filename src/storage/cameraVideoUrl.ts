/**
 * Single-slot registry for the object URL of an imported camera video.
 *
 * Importing a recording's sibling video creates an object URL that must outlive the import call —
 * it is stored on `recording.cameraUrl` and consumed by playback — so it cannot be revoked
 * locally. Routing every importer through here revokes the previously imported video's URL when the
 * next one is created, bounding the in-memory leak to at most one video blob at a time. Hosted /
 * sibling URLs are plain URLs and do not pass through here (nothing to revoke).
 */
let currentCameraObjectUrl: string | null = null;

export function createImportedCameraObjectUrl(video: Blob): string {
  if (currentCameraObjectUrl) {
    URL.revokeObjectURL(currentCameraObjectUrl);
  }
  currentCameraObjectUrl = URL.createObjectURL(video);
  return currentCameraObjectUrl;
}
