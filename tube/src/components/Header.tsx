import { Play, PenLine } from "lucide-react";

export default function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        <a href="/" className="flex items-center gap-2 text-white">
          <div className="flex size-8 items-center justify-center rounded-lg bg-linear-to-br from-violet-500 to-cyan-400">
            <Play className="fill-white text-white size-4" />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            NextEditor <span className="text-cyan-400">Tube</span>
          </span>
        </a>

        <a
          href="/code"
          className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
        >
          <PenLine className="size-4" />
          Record your own
        </a>
      </div>
    </header>
  );
}
