import { createRealtime, RealtimeProvider } from "@upstash/realtime/client";
import type { ReactNode } from "react";
import type { CollaborationRealtimeEvents } from "../../../src/collaboration/protocol";

export const { useRealtime: useCollaborationRealtime } =
  createRealtime<CollaborationRealtimeEvents>();

export function CollaborationRealtimeProvider({ children }: { children: ReactNode }) {
  return (
    <RealtimeProvider
      api={{ url: "/api/collaboration/realtime", withCredentials: true }}
      maxReconnectAttempts={5}
    >
      {children}
    </RealtimeProvider>
  );
}
