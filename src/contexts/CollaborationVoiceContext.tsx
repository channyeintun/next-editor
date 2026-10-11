import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getCollaborationVoiceAvailability } from "@next-editor/infra";
import { requestErrorStatus } from "../collaboration/errorMessage";
import type { VoiceEngine } from "../voice/engine";
import { isVoiceJoined, setVoiceJoinedForRecording } from "../voice/recorderBridge";
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
  wantsMicrophone: false,
  autoplayBlocked: false,
  roster: [],
  isLocalSpeaking: false,
};

// A failed availability probe that may be transient (no response, or a
// server fault) is asked once more after this delay before voice is hidden.
const AVAILABILITY_RETRY_DELAY_MS = 2_000;

// Module scope so getState hands useSyncExternalStore one stable snapshot.
const LOAD_FAILED_STATE: VoiceUiState = {
  ...UNAVAILABLE_STATE,
  unavailableReason: "load-failed",
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

/**
 * The engine and its media stack (partytracks + rxjs, ~19 KB gz) load only for
 * an active room, which learners never join. Kept out of the component: the
 * React Compiler cannot compile a function holding `import()`.
 */
function loadBrowserVoiceEngine() {
  return import("../voice/browserVoiceEngine");
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
  // The room whose engine chunk failed to load. Voice says so instead of
  // vanishing; a page reload is left to the user so a live room never loses
  // unsent edits to restore an optional feature.
  const [loadFailedRoomId, setLoadFailedRoomId] = useState<string | null>(null);

  useEffect(() => {
    if (!activeRoomId || !collaborationSessionId) return;
    let cancelled = false;
    let teardown: (() => void) | null = null;
    let availabilityRetry: ReturnType<typeof setTimeout> | null = null;
    const startEngine = (nextEngine: VoiceEngine) => {
      setEngine(nextEngine);
      // Recorder privacy bridge: while voice is joined, tab/display audio is
      // excluded from screen recordings (plan §11).
      const syncRecorderBridge = () => {
        setVoiceJoinedForRecording(isVoiceJoined(nextEngine.getUiState().state));
      };
      const unsubscribeRecorderBridge = nextEngine.subscribe(syncRecorderBridge);
      syncRecorderBridge();
      if (!isVoiceCapableBrowser() && !createEngine) {
        nextEngine.setAvailability("unsupported-browser");
      } else {
        const probe = checkAvailability ?? getCollaborationVoiceAvailability;
        // A network blip or 5xx at room entry gets one retry, so it does not
        // hide voice for the whole visit; a 4xx answer is final.
        const runProbe = (attempt: number) => {
          probe(activeRoomId).then(
            (enabled) => {
              if (!cancelled) nextEngine.setAvailability(enabled ? null : "feature-disabled");
            },
            (error: unknown) => {
              if (cancelled) return;
              const status = requestErrorStatus(error);
              if (attempt === 0 && (status === null || status >= 500)) {
                availabilityRetry = setTimeout(() => runProbe(1), AVAILABILITY_RETRY_DELAY_MS);
                return;
              }
              nextEngine.setAvailability("feature-disabled");
            },
          );
        };
        runProbe(0);
      }
      teardown = () => {
        unsubscribeRecorderBridge();
        nextEngine.dispose();
        setVoiceJoinedForRecording(false);
        setEngine((current) => (current === nextEngine ? null : current));
      };
    };
    const options = { roomId: activeRoomId, collaborationSessionId };
    if (createEngine) {
      startEngine(createEngine(options));
    } else {
      void loadBrowserVoiceEngine().then(
        ({ createBrowserVoiceEngine }) => {
          // The room may have changed or closed while the chunk loaded.
          if (!cancelled) startEngine(createBrowserVoiceEngine(options));
        },
        () => {
          if (!cancelled) setLoadFailedRoomId(activeRoomId);
        },
      );
    }
    return () => {
      // A room change or collaboration leave always tears voice down fully
      // before any new room's engine exists.
      cancelled = true;
      if (availabilityRetry !== null) clearTimeout(availabilityRetry);
      teardown?.();
    };
  }, [activeRoomId, collaborationSessionId, createEngine, checkAvailability]);

  const value: CollaborationVoiceContextValue = {
    subscribe: (listener) => engine?.subscribe(listener) ?? (() => undefined),
    getState: () =>
      engine?.getUiState() ??
      (activeRoomId !== null && loadFailedRoomId === activeRoomId
        ? LOAD_FAILED_STATE
        : UNAVAILABLE_STATE),
    join: () => engine?.join(),
    leave: () => engine?.leave(),
    mute: () => engine?.mute(),
    unmute: () => engine?.unmute(),
    retry: () => engine?.retry(),
    enableAudio: () => engine?.enableAudio(),
  };

  return <CollaborationVoiceContext value={value}>{children}</CollaborationVoiceContext>;
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

const NO_VOICE_SUBSCRIBE = () => () => undefined;
const NO_VOICE_STATE = () => UNAVAILABLE_STATE;

// For components (e.g. recording controls) that also render outside the
// collaboration provider tree.
export function useOptionalCollaborationVoiceState(): VoiceUiState | null {
  const context = useContext(CollaborationVoiceContext);
  const state = useSyncExternalStore(
    context?.subscribe ?? NO_VOICE_SUBSCRIBE,
    context?.getState ?? NO_VOICE_STATE,
    context?.getState ?? NO_VOICE_STATE,
  );
  return context ? state : null;
}

export function isVoiceJoinedState(state: VoiceUiState | null): boolean {
  return state !== null && isVoiceJoined(state.state);
}
