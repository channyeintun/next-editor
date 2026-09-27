import { useCallback, useRef, useState, type RefObject } from "react";
import {
  createCollaborationInvitation,
  listCollaborationInvitations,
  listCollaborationMembers,
  removeCollaborationMember,
  revokeCollaborationInvitation,
  updateCollaborationMemberRole,
} from "@next-editor/infra";
import type {
  CollaborationInvitation,
  CollaborationInviteRole,
  CollaborationMember,
} from "../../collaboration/protocol";
import type { CollaborationRoomProvider } from "../../collaboration/roomProvider";

/**
 * The room's members and invitations, and the changes an owner makes to them.
 * A list request applies only while it is the latest one and, when it names a
 * provider generation, while `providerGenerationRef` still holds it.
 */
export function useCollaborationRoster(
  providerRef: RefObject<CollaborationRoomProvider | null>,
  providerGenerationRef: RefObject<number>,
  flushCurrentEdits: (provider: CollaborationRoomProvider) => Promise<void>,
) {
  const roomDataRequestRef = useRef(0);
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [invitations, setInvitations] = useState<CollaborationInvitation[]>([]);

  const refreshRoomDataFor = useCallback(
    async (targetRoomId: string, owner: boolean, providerGeneration?: number) => {
      const request = ++roomDataRequestRef.current;
      const [{ members: nextMembers }, nextInvitations] = await Promise.all([
        listCollaborationMembers(targetRoomId),
        owner ? listCollaborationInvitations(targetRoomId) : Promise.resolve([]),
      ]);
      if (
        request !== roomDataRequestRef.current ||
        (providerGeneration !== undefined && providerGenerationRef.current !== providerGeneration)
      ) {
        return;
      }
      setMembers(nextMembers);
      setInvitations(nextInvitations);
    },
    [providerGenerationRef],
  );

  const refreshRoomData = useCallback(async () => {
    const current = providerRef.current?.session;
    if (!current) return;
    await refreshRoomDataFor(
      current.room.id,
      current.membership.role === "owner",
      providerGenerationRef.current,
    );
  }, [providerGenerationRef, providerRef, refreshRoomDataFor]);

  const createInvitation = useCallback(
    async (inviteRole: CollaborationInviteRole) => {
      const current = providerRef.current?.session;
      if (!current || current.membership.role !== "owner") {
        throw new Error("Only the room owner can create invitations.");
      }
      const invitation = await createCollaborationInvitation(current.room.id, {
        role: inviteRole,
      });
      setInvitations((existing) => [invitation, ...existing]);
      return invitation;
    },
    [providerRef],
  );

  const revokeInvitation = useCallback(
    async (invitationId: string) => {
      const current = providerRef.current?.session;
      if (!current) return;
      await revokeCollaborationInvitation(current.room.id, invitationId);
      setInvitations((existing) => existing.filter((item) => item.id !== invitationId));
    },
    [providerRef],
  );

  const updateMemberRole = useCallback(
    async (userId: string, nextRole: CollaborationInviteRole) => {
      const currentProvider = providerRef.current;
      const current = currentProvider?.session;
      if (!currentProvider || !current) return;
      await flushCurrentEdits(currentProvider);
      const member = await updateCollaborationMemberRole(current.room.id, userId, nextRole);
      setMembers((existing) =>
        existing.map((item) => (item.userId === member.userId ? member : item)),
      );
    },
    [flushCurrentEdits, providerRef],
  );

  const removeMember = useCallback(
    async (userId: string) => {
      const currentProvider = providerRef.current;
      const current = currentProvider?.session;
      if (!currentProvider || !current) return;
      await flushCurrentEdits(currentProvider);
      await removeCollaborationMember(current.room.id, userId);
      setMembers((existing) => existing.filter((item) => item.userId !== userId));
    },
    [flushCurrentEdits, providerRef],
  );

  /** Empties both lists; part of resetting the state of one room. */
  const resetRoster = useCallback(() => {
    setMembers([]);
    setInvitations([]);
  }, []);

  return {
    members,
    invitations,
    refreshRoomDataFor,
    refreshRoomData,
    createInvitation,
    revokeInvitation,
    updateMemberRole,
    removeMember,
    resetRoster,
  };
}
