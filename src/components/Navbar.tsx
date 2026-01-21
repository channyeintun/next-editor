import { Link } from 'react-router-dom';

const Navbar = () => {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-6 bg-transparent">
      <div className="flex items-center gap-2">
        <Link to="/" className="flex items-center gap-2 group">
          <img src="/logo.png" alt="next-editor logo" className="w-10 h-10 object-contain group-hover:scale-105 transition-transform" />
          <span className="text-xl font-machina tracking-tight">next-editor</span>
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <Link
          to="/code"
          className="px-6 py-2 rounded-full border border-white/10 bg-white/10 text-white text-sm font-semibold hover:bg-white hover:text-slate-950 transition-all"
        >
          Start creating
        </Link>
      </div>
    </nav>
  );
};

export default Navbar;
