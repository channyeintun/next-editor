import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../apiClient";
import { useGoogleCredentialSignIn } from "./useAuth";
import { loadGoogleIdentity } from "./googleIdentity";

// Renders nothing itself — mounts Google One Tap / automatic sign-in, whose
// prompt appears as browser-managed UI in the top corner. Only mounted while
// signed out (see AuthMenu), so a successful sign-in unmounts it and the
// cleanup dismisses any prompt still showing.
export default function GoogleOneTap() {
  const signIn = useGoogleCredentialSignIn();
  const config = useQuery({
    queryKey: ["auth", "google-config"],
    queryFn: async () => (await apiClient.get<{ clientId: string }>("/auth/google/config")).data,
    staleTime: Infinity,
  });

  const clientId = config.data?.clientId;
  const signInMutate = signIn.mutate;
  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    void loadGoogleIdentity().then((accountsId) => {
      if (cancelled || !accountsId) return;
      accountsId.initialize({
        client_id: clientId,
        callback: (response) => signInMutate(response.credential),
        // "Automatic sign-in": a returning user with a single Google session
        // who previously approved this app is signed in without a click.
        auto_select: true,
        use_fedcm_for_prompt: true,
      });
      // Makes "why is One Tap not showing" answerable from the console.
      // Google suppresses the prompt with an escalating per-site cooldown
      // after dismissals (suppressed_by_user), and only shows it at all when
      // the browser holds a signed-in Google session. Chrome's FedCM mode
      // deliberately reports opaque reasons (anti-fingerprinting); Safari and
      // Firefox report specific ones.
      accountsId.prompt((moment) => {
        if (moment.isNotDisplayed() || moment.isSkippedMoment()) {
          console.info(
            "[one-tap] prompt not shown:",
            moment.getNotDisplayedReason() ?? moment.getSkippedReason() ?? "no reason reported",
          );
        }
      });
    });
    return () => {
      cancelled = true;
      window.google?.accounts?.id?.cancel();
    };
  }, [clientId, signInMutate]);

  return null;
}
