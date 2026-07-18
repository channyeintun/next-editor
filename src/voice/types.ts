import type { VoiceParticipant } from "../collaboration/voiceProtocol";
import type { VoiceClientErrorCode, VoiceConnectionState, VoiceUnavailableReason } from "./machine";

// Roster entry as the UI consumes it: server-owned participant state plus
// locally computed speaking detection (never sent over the network).
export interface VoiceRosterEntry {
  participant: VoiceParticipant;
  isSelf: boolean;
  isSpeaking: boolean;
}

export interface VoiceUiState {
  state: VoiceConnectionState;
  unavailableReason: VoiceUnavailableReason | null;
  errorCode: VoiceClientErrorCode | null;
  // True when remote audio could not start due to browser autoplay policy;
  // the UI must offer an explicit Enable audio action.
  autoplayBlocked: boolean;
  roster: VoiceRosterEntry[];
  isLocalSpeaking: boolean;
}

// Public commands exposed by CollaborationVoiceContext. All are safe to call
// in any state; illegal transitions are ignored by the machine.
export interface VoiceCommands {
  join: () => void;
  leave: () => void;
  mute: () => void;
  unmute: () => void;
  retry: () => void;
  enableAudio: () => void;
}
