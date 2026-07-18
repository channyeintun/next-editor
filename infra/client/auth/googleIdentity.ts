// Minimal typings + loader for the subset of Google Identity Services (GIS)
// the app uses. The official library ships untyped and attaches itself to a
// window global.

export interface GoogleCredentialResponse {
  /** A Google-signed id_token JWT — verified server-side in googleIdToken.ts. */
  credential: string;
  select_by?: string;
}

interface GoogleIdConfiguration {
  client_id: string;
  callback: (response: GoogleCredentialResponse) => void;
  auto_select?: boolean;
  use_fedcm_for_prompt?: boolean;
  cancel_on_tap_outside?: boolean;
}

export interface GoogleAccountsId {
  initialize(config: GoogleIdConfiguration): void;
  prompt(): void;
  cancel(): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleAccountsId } };
  }
}

const GSI_SRC = "https://accounts.google.com/gsi/client";

let loaderPromise: Promise<GoogleAccountsId | null> | null = null;

// Injects the GSI script once per page. The script is served with
// Cross-Origin-Resource-Policy: cross-origin, so it loads under the app's
// COEP: require-corp isolation (headers verified 2026-07-19), and Google now
// serves its GSI iframes with compatible COEP/CORP headers too; on Chrome
// the One Tap prompt renders through FedCM browser UI rather than a page
// iframe in the first place.
export function loadGoogleIdentity(): Promise<GoogleAccountsId | null> {
  if (!loaderPromise) {
    loaderPromise = new Promise((resolve) => {
      const existing = window.google?.accounts?.id;
      if (existing) {
        resolve(existing);
        return;
      }
      const script = document.createElement("script");
      script.src = GSI_SRC;
      script.async = true;
      script.onload = () => resolve(window.google?.accounts?.id ?? null);
      // Blocked script (ad blocker, offline) — One Tap is silently
      // unavailable; the explicit sign-in buttons still work.
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
  }
  return loaderPromise;
}

// Google's guidance after an explicit sign-out: without this, automatic
// sign-in would put the user straight back into a session on the next
// prompt, making sign-out feel broken.
export function disableGoogleAutoSelect(): void {
  window.google?.accounts?.id?.disableAutoSelect();
}
