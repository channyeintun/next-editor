import type { ReactNode } from "react";
import Navbar from "./Navbar";

/**
 * The page frame shared by the lesson gallery, author profiles, playlists and
 * the gallery's eager loading skeleton: the dark full-height column, the
 * minimal Navbar and the centered main column. One home keeps the skeleton's
 * handover to the real page from moving anything.
 *
 * Eager-bundle-safe: Navbar is already there (LandingPage renders it).
 */
export default function GalleryShell({
  actions,
  loadingLabel,
  children,
}: {
  /** The Navbar's controls (infra's AuthMenu); the skeleton has none, but
   *  keeps their slot. */
  actions?: ReactNode;
  /** Set while standing in for a page that is still loading: the page is then
   *  one status named by this label, and its placeholder content is hidden. */
  loadingLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div
      aria-label={loadingLabel}
      className="flex min-h-dvh flex-col bg-[#11141c] font-telegraf text-white selection:bg-pinata-purple selection:text-white"
      role={loadingLabel ? "status" : undefined}
    >
      <Navbar
        minimal
        actions={
          // A fixed-height slot, in every state: the skeleton has no actions,
          // AuthMenu's loading placeholder is 36 px, its signed-out row 42 px
          // (a 24 px icon in a py-2 pill with a border) and the signed-in
          // avatar button 38 px. Sized to the tallest, the navbar keeps one
          // height, so the page under it never moves when the session
          // resolves (mobile CLS 0.188 came from exactly that).
          <div className="flex min-h-[42px] items-center">{actions}</div>
        }
      />
      <main
        className="mx-auto w-full max-w-7xl flex-1 px-6 pb-20 pt-2 sm:px-8"
        aria-hidden={loadingLabel ? true : undefined}
      >
        {children}
      </main>
    </div>
  );
}
