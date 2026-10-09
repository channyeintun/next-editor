import { useRef } from "react";
import { Search, X } from "lucide-react";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

export default function SearchBar({ value, onChange }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="relative mb-6 max-w-md">
      <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
      <input
        ref={inputRef}
        type="text"
        aria-label="Search authors and lessons"
        placeholder="Search authors and lessons..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && value && onChange("")}
        className="w-full rounded-full border border-white/10 bg-white/5 py-2.5 pl-11 pr-10 text-sm text-white placeholder-slate-400 transition-colors focus:border-pinata-purple/60 focus:bg-white/10"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            // This button unmounts once the value is empty, which would drop
            // focus to <body>; return it to the field so the next keystroke
            // types a new query, as the Escape path already does.
            onChange("");
            inputRef.current?.focus();
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 transition-colors hover:text-white"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
