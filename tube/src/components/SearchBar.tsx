import { Search } from "lucide-react";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

export default function SearchBar({ value, onChange }: SearchBarProps) {
  return (
    <div className="relative mb-6 max-w-md">
      <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
      <input
        type="text"
        placeholder="Search lessons..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-full border border-white/10 bg-white/5 py-2.5 pl-11 pr-4 text-sm text-white placeholder-slate-500 outline-none transition-colors focus:border-pinata-purple/60 focus:bg-white/10"
      />
    </div>
  );
}
