export function canRecordInLiveRoom(
  recordModeRequested: boolean,
  hasLiveRoom: boolean,
  isHost: boolean,
): boolean {
  return recordModeRequested && (!hasLiveRoom || isHost);
}

export function liveRoomEndBlockReason(
  isRecording: boolean,
  hasPendingCollaborationUpdates: boolean,
): string | null {
  if (isRecording) return "Stop and finalize the host recording before ending the live room.";
  if (hasPendingCollaborationUpdates) {
    return "Live cannot end until offline collaboration changes synchronize.";
  }
  return null;
}
