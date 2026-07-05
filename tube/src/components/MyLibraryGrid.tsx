import { Link } from "react-router";
import { useMyLessons } from "@next-editor/infra";
import MyLessonCard from "./MyLessonCard";

export default function MyLibraryGrid() {
  const { data, isPending, isError, refetch } = useMyLessons();

  if (isPending) {
    return <div className="flex justify-center py-20 text-slate-400">Loading your lessons…</div>;
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <p className="text-red-400">Failed to load your lessons</p>
        <button
          type="button"
          onClick={() => refetch()}
          className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
        >
          Try again
        </button>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center text-slate-400">
        <p>You haven’t uploaded any lessons yet.</p>
        <Link
          to="/code"
          className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
        >
          Start creating
        </Link>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 pb-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {data.map((lesson) => (
        <MyLessonCard key={lesson.id} lesson={lesson} />
      ))}
    </div>
  );
}
