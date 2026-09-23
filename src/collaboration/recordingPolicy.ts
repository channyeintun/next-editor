export function canRecordInLiveRoom(
  recordModeRequested: boolean,
  hasLiveRoom: boolean,
  isHost: boolean,
): boolean {
  return recordModeRequested && (!hasLiveRoom || isHost);
}

/** Unsent edits are checked separately, by the flush that closing the room runs first. */
export function liveRoomEndBlockReason(isRecording: boolean): string | null {
  return isRecording ? "Stop and finalize the host recording before ending the live room." : null;
}
