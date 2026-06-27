const EDITOR_BASE = import.meta.env.VITE_EDITOR_BASE || "https://nexteditor.dev";

export default function Footer() {
  return (
    <footer className="border-t border-white/10 py-6 text-center text-xs text-slate-500">
      <a href={EDITOR_BASE} className="hover:text-white transition-colors">
        nexteditor.dev
      </a>{" "}
      &mdash; Record, replay, and share interactive code lessons.
    </footer>
  );
}
