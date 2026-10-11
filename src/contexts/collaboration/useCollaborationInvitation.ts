import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
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

const SIGN_IN_HINT = "Sign in to accept this collaboration invitation.";

/**
 * Clears the sign-in hint once it no longer applies (the visitor signed in, or
 * the invitation is gone). Only the hint: an error shown since, such as a
 * failed claim, stays.
 */
function clearSignInHint(shownRef: RefObject<boolean>, setError: (message: string | null) => void) {
  if (!shownRef.current) return;
  shownRef.current = false;
  setError(null);
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
  // Whether the error on screen is this hook's sign-in hint.
  const signInHintShownRef = useRef(false);

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
      clearSignInHint(signInHintShownRef, setError);
      return;
    }
    if (!isSignedIn) {
      setPendingInviteToken(null);
      signInHintShownRef.current = true;
      setError(SIGN_IN_HINT);
      return;
    }
    clearSignInHint(signInHintShownRef, setError);
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
      signInHintShownRef.current = false;
      setError(messageFromError(error, "The collaboration invitation could not be accepted."));
      claimingTokenRef.current = null;
    } finally {
      setIsAcceptingInvitation(false);
    }
  }, [pendingInviteToken, setError, setSearchParams]);

  const declineInvitation = useCallback(() => {
    setPendingInviteToken(null);
    clearSignInHint(signInHintShownRef, setError);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("invite");
        return next;
      },
      { replace: true },
    );
  }, [setError, setSearchParams]);

  return { pendingInviteToken, isAcceptingInvitation, acceptInvitation, declineInvitation };
}
