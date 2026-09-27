import { useCallback, useEffect, useRef, useState } from "react";
import type { SetURLSearchParams } from "react-router";
import { claimCollaborationInvitation } from "@next-editor/infra";
import { messageFromError } from "../../collaboration/errorMessage";

interface CollaborationInvitationOptions {
  /** The URL's `?invite=` token. */
  inviteToken: string | null;
  isAuthLoading: boolean;
  isSignedIn: boolean;
  setSearchParams: SetURLSearchParams;
  /** Shows a collaboration error, or clears it with null. */
  setError: (message: string | null) => void;
}

/** Stages a `?invite=` token and claims it only through `acceptInvitation`. */
export function useCollaborationInvitation({
  inviteToken,
  isAuthLoading,
  isSignedIn,
  setSearchParams,
  setError,
}: CollaborationInvitationOptions) {
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(null);
  const [isAcceptingInvitation, setIsAcceptingInvitation] = useState(false);
  const claimingTokenRef = useRef<string | null>(null);

  // Claiming an invitation is a state-changing POST that permanently adds the
  // caller to someone else's room, and joining reprojects the room's document
  // over the local workspace — which then auto-starts the runtime and runs the
  // room's package scripts. Firing that from a bare `?invite=` on mount made a
  // single link enough to plant and execute another person's files in a
  // signed-in visitor's workspace, and to start broadcasting their identity,
  // cursor and open file. So the token is only staged here; `acceptInvitation`
  // has to be called from a real user gesture.
  useEffect(() => {
    if (!inviteToken || isAuthLoading) {
      setPendingInviteToken(null);
      return;
    }
    if (!isSignedIn) {
      setPendingInviteToken(null);
      setError("Sign in to accept this collaboration invitation.");
      return;
    }
    if (claimingTokenRef.current === inviteToken) return;
    setPendingInviteToken(inviteToken);
  }, [inviteToken, isAuthLoading, isSignedIn, setError]);

  const acceptInvitation = useCallback(async () => {
    const token = pendingInviteToken;
    if (!token || claimingTokenRef.current === token) return;
    claimingTokenRef.current = token;
    setIsAcceptingInvitation(true);
    try {
      const session = await claimCollaborationInvitation(token);
      setError(null);
      setPendingInviteToken(null);
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("invite");
          next.set("room", session.room.id);
          return next;
        },
        { replace: true },
      );
    } catch (error: unknown) {
      setError(messageFromError(error, "The collaboration invitation could not be accepted."));
      claimingTokenRef.current = null;
    } finally {
      setIsAcceptingInvitation(false);
    }
  }, [pendingInviteToken, setError, setSearchParams]);

  const declineInvitation = useCallback(() => {
    setPendingInviteToken(null);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("invite");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  return { pendingInviteToken, isAcceptingInvitation, acceptInvitation, declineInvitation };
}
