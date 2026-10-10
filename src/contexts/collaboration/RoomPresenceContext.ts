import { createContext, useContext } from "react";
import type { CollaborationPresenceState } from "../../collaboration/protocol";

export type CollaborationParticipant = CollaborationPresenceState;

/**
 * Who is in the room and whom this tab follows. Every awareness event and
 * every viewport this member publishes changes it, so CollaborationProvider
 * provides it apart from CollaborationContext: a component that reads only the
 * room, its teaching surfaces or its commands does not re-render on each
 * remote cursor move or scroll.
 */
export interface RoomPresenceValue {
  participants: CollaborationParticipant[];
  /** This tab's own participant's collaborationParticipantKey; null without a room or user. */
  ownParticipantKey: string | null;
  followedParticipantKey: string | null;
  followedParticipant: CollaborationParticipant | null;
  /**
   * Bumps once when a follow ended during a follow application's release
   * window, where publishSurface still bails; the surface bridge republishes on it.
   */
  surfaceRepublishVersion: number;
}

export const RoomPresenceContext = createContext<RoomPresenceValue | null>(null);

export function useRoomPresence(): RoomPresenceValue {
  const context = useContext(RoomPresenceContext);
  if (!context) throw new Error("useRoomPresence must be used within a CollaborationProvider");
  return context;
}

export function useOptionalRoomPresence(): RoomPresenceValue | null {
  return useContext(RoomPresenceContext);
}
