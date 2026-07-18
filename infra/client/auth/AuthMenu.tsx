import { useState, useEffect } from "react";
import { Link } from "react-router";
import { KeyRound, LibraryBig, LogOut, Plus } from "lucide-react";
import { useAuth, useSignOut, signInUrl, avatarProxyUrl } from "./useAuth";
import {
  browserSupportsPasskeys,
  isPasskeyCancel,
  passkeyErrorMessage,
  useRegisterPasskey,
  useSignInWithPasskey,
} from "./usePasskey";
import GoogleOneTap from "./GoogleOneTap";
import GoogleIcon from "@app/components/icon/Google";
import { usePostHog } from "@posthog/react";

// Sign-in link / avatar menu for the Navbar's `actions` slot. Matches the
// existing pill-button style ("Start creating" in Navbar.tsx) so it reads as
// part of the same nav, not a bolted-on widget.
export default function AuthMenu() {
  const posthog = usePostHog();
  const { user, isSignedIn, isLoading } = useAuth();
  const signOut = useSignOut();
  const [menuOpen, setMenuOpen] = useState(false);

  // Identify user on login and on every page load when already signed in.
  useEffect(() => {
    if (user) {
      posthog?.identify(user.id, { username: user.username });
    }
  }, [user, posthog]);

  if (isLoading) {
    return <div className="size-9 rounded-full bg-white/5" aria-hidden="true" />;
  }

  if (!isSignedIn || !user) {
    return (
      <div className="flex items-center gap-2">
        <GoogleOneTap />
        <a
          href={signInUrl(window.location.pathname)}
          className="flex gap-3 items-center px-3 py-2 sm:px-6 rounded-full border border-white/10 bg-white/10 text-white text-xs sm:text-sm leading-none font-semibold whitespace-nowrap hover:bg-white hover:text-slate-950 transition-all font-telegraf"
        >
          <GoogleIcon /> Sign in with Google
        </a>
        {browserSupportsPasskeys() && <PasskeySignInButton />}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        className="flex items-center gap-2 rounded-full border border-white/10 bg-white/10 py-1 pl-1 pr-3 text-sm text-white transition-all hover:bg-white/20"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        {user.avatarUrl ? (
          <img
            src={avatarProxyUrl(user.avatarUrl)}
            alt=""
            className="size-7 rounded-full"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="flex size-7 items-center justify-center rounded-full bg-pinata-purple text-xs font-semibold uppercase">
            {(user.name || user.email)[0]}
          </span>
        )}
        <span className="hidden max-w-32 truncate sm:inline">{user.name || user.email}</span>
      </button>

      {menuOpen && (
        <>
          {/* Click-outside catcher — a plain overlay is simpler and more
              robust here than wiring a document listener for one menu. */}
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setMenuOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-xl border border-white/10 bg-[#11141c] shadow-xl"
          >
            <Link
              to="/code"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm text-white transition-colors hover:bg-white/10"
            >
              <Plus className="size-4 text-slate-400" />
              Start creating
            </Link>
            <Link
              to={`/learn/@${user.username}`}
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm text-white transition-colors hover:bg-white/10"
            >
              <LibraryBig className="size-4 text-slate-400" />
              My Library
            </Link>
            {browserSupportsPasskeys() && <AddPasskeyMenuItem />}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                posthog?.capture("signed_out");
                posthog?.reset();
                signOut.mutate();
              }}
              disabled={signOut.isPending}
              className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm text-white transition-colors hover:bg-white/10 disabled:opacity-60"
            >
              <LogOut className="size-4 text-slate-400" />
              {signOut.isPending ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Icon-only sibling of the Google pill: passkey sign-in has no account
// picker to show, so a compact key button keeps the signed-out navbar from
// growing a second full-width pill.
function PasskeySignInButton() {
  const posthog = usePostHog();
  const signIn = useSignInWithPasskey();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Sign in with a passkey"
        title="Sign in with a passkey"
        disabled={signIn.isPending}
        onClick={() => {
          setError(null);
          signIn.mutate(undefined, {
            onSuccess: () => posthog?.capture("signed_in_with_passkey"),
            onError: (err) => {
              if (isPasskeyCancel(err)) return;
              setError(passkeyErrorMessage(err, "Passkey sign-in failed. Please try again."));
            },
          });
        }}
        className="flex items-center justify-center size-9 rounded-full border border-white/10 bg-white/10 text-white transition-all hover:bg-white hover:text-slate-950 disabled:opacity-60"
      >
        <KeyRound className="size-4" />
      </button>
      {error && (
        <div
          role="alert"
          className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border border-white/10 bg-[#11141c] px-3 py-2 text-xs text-red-300 shadow-xl"
        >
          {error}
        </div>
      )}
    </div>
  );
}

// Lives inside the avatar dropdown. Deliberately keeps the menu open through
// the whole flow so the pending/added/failed feedback is visible where the
// user just clicked.
function AddPasskeyMenuItem() {
  const posthog = usePostHog();
  const register = useRegisterPasskey();
  const [outcome, setOutcome] = useState<"idle" | "added" | "failed">("idle");

  useEffect(() => {
    if (outcome === "idle") return;
    const timer = setTimeout(() => setOutcome("idle"), 2500);
    return () => clearTimeout(timer);
  }, [outcome]);

  const label = register.isPending
    ? "Adding passkey…"
    : outcome === "added"
      ? "Passkey added"
      : outcome === "failed"
        ? "Couldn't add passkey"
        : "Add a passkey";

  return (
    <button
      type="button"
      role="menuitem"
      disabled={register.isPending}
      onClick={() => {
        register.mutate(undefined, {
          onSuccess: () => {
            setOutcome("added");
            posthog?.capture("passkey_added");
          },
          onError: (err) => setOutcome(isPasskeyCancel(err) ? "idle" : "failed"),
        });
      }}
      className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm text-white transition-colors hover:bg-white/10 disabled:opacity-60"
    >
      <KeyRound className="size-4 text-slate-400" />
      {label}
    </button>
  );
}
