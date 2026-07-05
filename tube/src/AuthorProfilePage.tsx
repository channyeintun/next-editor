import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import Navbar from "@app/components/Navbar";
import { AuthMenu, avatarProxyUrl, useAuth, useAuthorProfile } from "@next-editor/infra";
import Breadcrumb from "./components/Breadcrumb";
import MyLibraryGrid from "./components/MyLibraryGrid";
import LessonCard from "./components/LessonCard";

// /learn/@username: the signed-in owner's own management view (draft +
// published, same as the old /learn/mine) when the username is their own,
// or a read-only public profile (published lessons only) for anyone else's
// username — including a signed-out visitor.
export default function AuthorProfilePage() {
  const { username } = useParams();
  const { user, isLoading: authLoading } = useAuth();

  if (authLoading) {
    return (
      <div className="flex min-h-dvh flex-col bg-[#11141c] font-telegraf text-white">
        <Navbar minimal actions={<AuthMenu />} />
      </div>
    );
  }

  if (user?.username === username) {
    return (
      <Shell>
        <div className="py-4">
          <Breadcrumb title="My Library" />
        </div>
        <MyLibraryGrid />
      </Shell>
    );
  }

  return <PublicAuthorProfile username={username!} />;
}

function PublicAuthorProfile({ username }: { username: string }) {
  const { data, isPending, isError, refetch } = useAuthorProfile(username);

  if (isPending) {
    return (
      <Shell>
        <div className="flex justify-center py-20 text-slate-400">Loading profile…</div>
      </Shell>
    );
  }

  if (isError) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <p className="text-red-400">Failed to load this profile</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
          >
            Try again
          </button>
        </div>
      </Shell>
    );
  }

  // data === null → no user matches this username.
  if (!data) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-4 py-20 text-center text-slate-400">
          <p>Author not found.</p>
          <Link
            to="/learn"
            className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
          >
            Back to lessons
          </Link>
        </div>
      </Shell>
    );
  }

  const displayName = data.user.name ?? data.user.username;

  return (
    <Shell>
      <div className="py-4">
        <Breadcrumb title={displayName} />
      </div>

      <div className="flex items-center gap-3 pb-6">
        {data.user.avatarUrl ? (
          <img
            src={avatarProxyUrl(data.user.avatarUrl)}
            alt=""
            className="size-12 rounded-full"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="flex size-12 items-center justify-center rounded-full bg-pinata-purple text-lg font-semibold uppercase">
            {displayName[0]}
          </span>
        )}
        <div>
          <h1 className="text-lg font-semibold text-white">{displayName}</h1>
          <p className="text-sm text-slate-400">@{data.user.username}</p>
        </div>
      </div>

      {data.lessons.length === 0 ? (
        <div className="flex justify-center py-20 text-slate-400">No published lessons yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-5 pb-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data.lessons.map((lesson) => (
            <LessonCard key={lesson.slug} lesson={lesson} />
          ))}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-[#11141c] font-telegraf text-white selection:bg-pinata-purple selection:text-white">
      <Navbar actions={<AuthMenu />} />
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 pb-20 pt-2 sm:px-8">{children}</main>
    </div>
  );
}
