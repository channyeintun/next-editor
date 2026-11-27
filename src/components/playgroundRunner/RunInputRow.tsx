import { useEffect, useRef, useState } from "react";
import { PLAYGROUND_INPUT_LINE_MAX_LENGTH } from "../../runtime/playgroundLanguage";

/**
 * The runner dock's keyboard: one line for a program that waits at a prompt.
 * It is on screen only while the program waits, under the console that shows
 * the prompt. Enter hands the line over; the program echoes it into the
 * console, as a terminal does, and goes on. Ctrl+D on an empty line ends the
 * input instead, as it does in a terminal: a program that reads until there is
 * no more (`for line in sys.stdin`) would otherwise never be done.
 *
 * A field rather than typing into the console itself, so that a phone's
 * keyboard, an input method (Burmese is typed through one) and a screen reader
 * all meet an ordinary text field.
 */
function RunInputRow({ onSubmit }: { onSubmit: (line: string | null) => void }) {
  const [line, setLine] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The learner pressed Run and the program now asks them something, so the
    // field takes the keyboard — unless they are typing somewhere outside the
    // dock (back in the editor while the program started), where taking it
    // would send their code into the program.
    const input = inputRef.current;
    const focused = document.activeElement;
    const dock = input?.closest('[data-cursor-replay-target="runtime-dock"]');
    if (!focused || focused === document.body || dock?.contains(focused)) {
      input?.focus();
    }
  }, []);

  return (
    <form
      className="flex items-center gap-3 border-t border-[#11151d] bg-[#191d25] px-4 py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(line);
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={line}
        onChange={(event) => setLine(event.target.value)}
        onKeyDown={(event) => {
          // Only on an empty line, as in a terminal; with text in the field
          // the key keeps what it does there (it deletes forward on a Mac).
          if (event.ctrlKey && event.key.toLowerCase() === "d" && line === "") {
            event.preventDefault();
            onSubmit(null);
          }
        }}
        maxLength={PLAYGROUND_INPUT_LINE_MAX_LENGTH}
        aria-label="Input for the program"
        placeholder="The program is waiting — type a line, then press Enter"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="send"
        className="h-9 min-w-0 flex-1 rounded-md border border-slate-700 bg-[#11141c] px-3 font-mono text-[13px] text-slate-100 outline-none placeholder:text-slate-400 focus:border-slate-500"
      />
      <button
        type="submit"
        className="rounded-md bg-[#222d3b] px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-[#b5d5ff] transition-colors hover:bg-[#2a3a4d] hover:text-white"
        title="Give the line to the program (Enter). Ctrl+D on an empty line ends the input."
      >
        Enter
      </button>
    </form>
  );
}

export default RunInputRow;
