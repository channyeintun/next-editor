import { Link } from "react-router";

export default function Footer() {
  return (
    <footer className="border-t border-slate-900 px-6 py-12">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 md:flex-row">
        <Link to="/" className="flex items-center gap-2">
          <img src="/logo.svg" alt="logo" className="size-6 object-contain" />
          <span className="font-machina tracking-tight">next-editor</span>
        </Link>
        <p className="text-sm text-slate-500">© 2026 Next Editor</p>
      </div>
    </footer>
  );
}
