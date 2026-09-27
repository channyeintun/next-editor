import type { CollaborationRoomProvider } from "./roomProvider";

/** Stops `provider`, first trying once to send its pending updates while it is live. */
export function stopProviderAfterBestEffortFlush(provider: CollaborationRoomProvider): void {
  if (provider.connectionState === "live" && provider.hasPendingUpdates) {
    void provider.flushNow().then(
      () => provider.stop(),
      () => provider.stop(),
    );
  } else {
    provider.stop();
  }
}
