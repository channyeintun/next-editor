export default function LessonCardSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="aspect-video w-full rounded-xl bg-slate-800" />
      <div className="mt-3 space-y-2">
        <div className="h-4 w-3/4 rounded bg-slate-800" />
        <div className="h-3 w-1/2 rounded bg-slate-800" />
      </div>
    </div>
  );
}
