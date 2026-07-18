import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getCollaborationVoiceAvailability } from "@next-editor/infra";
import { VoiceEngine, type VoiceEngineDeps } from "../voice/engine";
import { createVoiceMediaSession } from "../voice/partyTracksAdapter";
import { createRemoteAudioSink } from "../voice/remoteAudioSink";
import { createSpeakingDetector } from "../voice/speakingDetector";
import type { VoiceCommands, VoiceUiState } from "../voice/types";
import { useOptionalCollaboration } from "./CollaborationContext";

// React integration for collaboration voice chat. The engine owns all media
// state; this provider only manages one engine per active room/session and
// exposes it through a subscription so speaking-frequency updates rerender
// exactly the components that read voice state, never the editor tree.

const UNAVAILABLE_STATE: VoiceUiState = {
  state: "unavailable",
  unavailableReason: "no-room",
  errorCode: null,
  autoplayBlocked: false,
  roster: [],
  isLocalSpeaking: false,
};

interface CollaborationVoiceContextValue extends VoiceCommands {
  subscribe: (listener: () => void) => () => void;
  getState: () => VoiceUiState;
}

const CollaborationVoiceContext = createContext<CollaborationVoiceContextValue | null>(null);

export function isVoiceCapableBrowser(): boolean {
  return (
    typeof WebSocket !== "undefined" &&
    typeof RTCPeerConnection !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

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

export interface CollaborationVoiceProviderProps {
  children: ReactNode;
  // Test seam: production uses the browser dependencies.
  createEngine?: (options: { roomId: string; collaborationSessionId: string }) => VoiceEngine;
  checkAvailability?: (roomId: string) => Promise<boolean>;
}

export function CollaborationVoiceProvider({
  children,
  createEngine,
  checkAvailability,
}: CollaborationVoiceProviderProps) {
  const collaboration = useOptionalCollaboration();
  const roomId = collaboration?.session?.room.id ?? null;
  const roomStatus = collaboration?.session?.room.status ?? null;
  const collaborationSessionId = collaboration?.provider?.awarenessSessionId ?? null;
  const activeRoomId = roomStatus === "active" ? roomId : null;

  const [engine, setEngine] = useState<VoiceEngine | null>(null);

  useEffect(() => {
    if (!activeRoomId || !collaborationSessionId) return;
    let cancelled = false;
    const nextEngine = createEngine
      ? createEngine({ roomId: activeRoomId, collaborationSessionId })
      : new VoiceEngine({ roomId: activeRoomId, collaborationSessionId }, browserVoiceEngineDeps());
    setEngine(nextEngine);
    if (!isVoiceCapableBrowser() && !createEngine) {
      nextEngine.setAvailability("unsupported-browser");
    } else {
      const probe = checkAvailability ?? getCollaborationVoiceAvailability;
      probe(activeRoomId).then(
        (enabled) => {
          if (!cancelled) nextEngine.setAvailability(enabled ? null : "feature-disabled");
        },
        () => {
          if (!cancelled) nextEngine.setAvailability("feature-disabled");
        },
      );
    }
    return () => {
      // A room change or collaboration leave always tears voice down fully
      // before any new room's engine exists.
      cancelled = true;
      nextEngine.dispose();
      setEngine((current) => (current === nextEngine ? null : current));
    };
  }, [activeRoomId, collaborationSessionId, createEngine, checkAvailability]);

  const value: CollaborationVoiceContextValue = {
    subscribe: (listener) => engine?.subscribe(listener) ?? (() => undefined),
    getState: () => engine?.getUiState() ?? UNAVAILABLE_STATE,
    join: () => engine?.join(),
    leave: () => engine?.leave(),
    mute: () => engine?.mute(),
    unmute: () => engine?.unmute(),
    retry: () => engine?.retry(),
    enableAudio: () => engine?.enableAudio(),
  };

  return (
    <CollaborationVoiceContext.Provider value={value}>
      {children}
    </CollaborationVoiceContext.Provider>
  );
}

export function useCollaborationVoice(): CollaborationVoiceContextValue {
  const context = useContext(CollaborationVoiceContext);
  if (!context) {
    throw new Error("useCollaborationVoice requires CollaborationVoiceProvider");
  }
  return context;
}

// Subscribes the calling component to live voice state. Only components
// using this hook rerender on voice/speaking updates.
export function useCollaborationVoiceState(): VoiceUiState {
  const context = useCollaborationVoice();
  return useSyncExternalStore(context.subscribe, context.getState, context.getState);
}
