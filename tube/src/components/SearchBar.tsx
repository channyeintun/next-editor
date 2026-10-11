import { useId, useRef, type RefObject } from "react";
import { CornerDownLeft, Search, X } from "lucide-react";
import { isImeComposingKey } from "@app/utils/keyboardPlatform";

interface SearchBarProps {
  /** The field, for the page to give focus back to (after Try again). */
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  /** Enter (or a phone keyboard's Search key): run the search for `value`. */
  onSubmit: () => void;
  /** Escape or Clear search: empty the field and go back to the gallery. */
  onClear: () => void;
  /** The field holds text that has not been searched for yet. */
  isDirty: boolean;
}

/**
 * The gallery's search field. Typing only edits the query; Enter searches, so
 * the results below never change under the reader's keystrokes.
 */
export default function SearchBar({
  inputRef,
  value,
  onChange,
  onSubmit,
  onClear,
  isDirty,
}: SearchBarProps) {
  // Set by the Enter that ends an input method's composition, which is the input
  // method's: the form submission it may still cause does not search.
  const imeEnterRef = useRef(false);
  const hintId = useId();
  return (
    <form
      role="search"
      className="relative mb-6 max-w-md"
      onSubmit={(event) => {
        event.preventDefault();
        if (imeEnterRef.current) {
          imeEnterRef.current = false;
          return;
        }
        onSubmit();
      }}
    >
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-slate-400"
      />
      <input
        ref={inputRef}
        type="text"
        aria-label="Search authors and lessons"
        aria-describedby={hintId}
        placeholder="Search authors and lessons..."
        enterKeyHint="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") imeEnterRef.current = isImeComposingKey(e.nativeEvent);
          // An Escape that cancels an input method's conversion is the input method's.
          if (e.key === "Escape" && !isImeComposingKey(e.nativeEvent) && (value || isDirty)) {
            onClear();
          }
        }}
        // Room for the hint and Clear only when they can show, so the placeholder
        // (the field's visible label) fits on narrow phones.
        className={`w-full rounded-full border border-white/10 bg-white/5 py-2.5 pl-11 ${
          value || isDirty ? "pr-24" : "pr-10"
        } text-sm text-white placeholder-slate-400 transition-colors focus:border-pinata-purple/60 focus:bg-white/10`}
      />
      <span id={hintId} className="sr-only">
        Press Enter to search.
      </span>
      {/* Taps pass through to the field (the hint is a picture, not a key); only
          Clear takes them. */}
      <div className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {/* Says the query has not run yet; Enter runs it. */}
        <span
          aria-hidden="true"
          className={`inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[11px] text-slate-300 transition-opacity duration-150 motion-reduce:transition-none ${
            isDirty ? "opacity-100" : "opacity-0"
          }`}
        >
          Enter
          <CornerDownLeft className="size-3" />
        </span>
        {value && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              // This button unmounts once the value is empty, which would drop
              // focus to <body>; return it to the field so the next keystroke
              // types a new query, as the Escape path already does.
              onClear();
              inputRef.current?.focus();
            }}
            className="pointer-events-auto rounded-full p-1 text-slate-400 transition-colors hover:text-white"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </form>
  );
}
