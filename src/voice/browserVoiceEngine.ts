import { VoiceEngine, type VoiceEngineDeps, type VoiceEngineOptions } from "./engine";
import { createVoiceMediaSession } from "./partyTracksAdapter";
import { createRemoteAudioSink } from "./remoteAudioSink";
import { createSpeakingDetector } from "./speakingDetector";

function browserVoiceEngineDeps(): VoiceEngineDeps {
  return {
    createSocket: (url) => new WebSocket(url),
    createMediaSession: createVoiceMediaSession,
    createSink: (onBlockedChange) => createRemoteAudioSink({ onBlockedChange }),
    createSpeakingDetector,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
  };
}

/**
 * The voice engine on the real browser media stack (partytracks, rxjs, Web
 * Audio). Its own module so CollaborationVoiceProvider can import it only once
 * a room is active, rather than with every editor.
 */
export function createBrowserVoiceEngine(options: VoiceEngineOptions): VoiceEngine {
  return new VoiceEngine(options, browserVoiceEngineDeps());
}
