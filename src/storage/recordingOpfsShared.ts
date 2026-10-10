export const RECORDING_OPFS_DIRECTORY = "recording-streams";

export function recordingOpfsFilename(recordingId: string): string {
  return `${encodeURIComponent(recordingId)}.scr3`;
}

/** A missing directory or file, as the File System Access API reports it. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}
