import { useState } from "react";
import { Link } from "react-router";
import { LibraryBig, LogOut, Plus } from "lucide-react";
import { useAuth, useSignOut, signInUrl, avatarProxyUrl } from "./useAuth";

// Sign-in link / avatar menu for the Navbar's `actions` slot. Matches the
// existing pill-button style ("Start creating" in Navbar.tsx) so it reads as
// part of the same nav, not a bolted-on widget.
export default function AuthMenu() {
  const { user, isSignedIn, isLoading } = useAuth();
  const signOut = useSignOut();
  const [menuOpen, setMenuOpen] = useState(false);

  if (isLoading) {
    return <div className="size-9 rounded-full bg-white/5" aria-hidden="true" />;
  }

  if (!isSignedIn || !user) {
    return (
      <a
        href={signInUrl(window.location.pathname)}
        className="px-3 py-2 sm:px-6 rounded-full border border-white/10 bg-white/10 text-white text-xs sm:text-sm leading-none font-semibold whitespace-nowrap hover:bg-white hover:text-slate-950 transition-all font-telegraf"
      >
        Sign in with Google
      </a>
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
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
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
