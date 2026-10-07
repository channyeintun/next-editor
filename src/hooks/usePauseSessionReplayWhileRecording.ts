import { useEffect } from "react";
import { analytics } from "../utils/analytics";

/**
 * PostHog session replay's DOM observer competes for CPU with lesson capture
 * (content deltas + preview rrweb + audio); pause it while the user is
 * actively recording and resume when they stop.
 */
export function usePauseSessionReplayWhileRecording(isRecording: boolean): void {
  useEffect(() => {
    if (!isRecording) {
      return;
    }
    analytics.stopSessionRecording();
    return () => {
      analytics.startSessionRecording();
    };
  }, [isRecording]);
}
