import { useEffect } from "react";
import { usePostHog } from "@posthog/react";

/**
 * PostHog session replay's DOM observer competes for CPU with lesson capture
 * (content deltas + preview rrweb + audio); pause it while the user is
 * actively recording and resume when they stop.
 */
export function usePauseSessionReplayWhileRecording(isRecording: boolean): void {
  const posthog = usePostHog();

  useEffect(() => {
    if (!isRecording) {
      return;
    }
    posthog?.stopSessionRecording();
    return () => {
      posthog?.startSessionRecording();
    };
  }, [isRecording, posthog]);
}
