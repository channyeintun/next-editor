import { Navigate } from "react-router";
import Navbar from "@app/components/Navbar";
import { AuthMenu, useAuth } from "@next-editor/infra";
import MyLibraryGrid from "./components/MyLibraryGrid";

// Owner-only view of every lesson the signed-in user has uploaded (draft +
// published), separate from the public, published-only /learn gallery.
export default function MyLibraryPage() {
  const { isSignedIn, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-dvh flex-col bg-[#11141c] font-telegraf text-white">
        <Navbar actions={<AuthMenu />} />
      </div>
    );
  }

  // Nothing owner-specific to preserve across a sign-in redirect here — unlike
  // the upload flow, so a plain redirect (not a sign-in prompt) is enough.
  if (!isSignedIn) {
    return <Navigate to="/learn" replace />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-[#11141c] font-telegraf text-white selection:bg-pinata-purple selection:text-white">
      <Navbar actions={<AuthMenu />} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 pb-20 pt-2 sm:px-8">
        <h1 className="py-4 text-lg font-bold tracking-wide">My Library</h1>
        <MyLibraryGrid />
      </main>
    </div>
  );
}
