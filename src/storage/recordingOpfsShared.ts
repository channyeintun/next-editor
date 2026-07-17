export const RECORDING_OPFS_DIRECTORY = "recording-streams";

export function recordingOpfsFilename(recordingId: string): string {
  return `${encodeURIComponent(recordingId)}.scr3`;
}
