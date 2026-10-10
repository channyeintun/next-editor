import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { Search, X } from "lucide-react";
import ModalShell from "../ModalShell";
import LangText from "../LangText";
import { getFileIcon } from "../fileSidebar/fileIcons";
import { useWorkspaceActiveFilePath, useWorkspaceTreeFiles } from "../../hooks/useWorkspace";
import type { WorkspaceTreeFile } from "../../types/workspace";
import { isImeComposingKey } from "../../utils/keyboardPlatform";
import { isGoToFileShortcut } from "./goToFileShortcut";
import {
  highlightRuns,
  prepareQuickOpenCandidates,
  QUICK_OPEN_RESULT_LIMIT,
  rankQuickOpenFiles,
  type QuickOpenCandidate,
} from "./quickOpenMatch";

/** How far Page Up and Page Down move through the results. */
const PAGE_SIZE = 10;

// Keyed by path, not position: when typing brings a new file to the top, the
// active descendant changes and a screen reader reads the new file.
const optionIdFor = (listboxId: string, path: string) => `${listboxId}-${encodeURIComponent(path)}`;

const KBD_CLASS =
  "rounded border border-slate-600 bg-slate-800 px-1 py-px font-mono text-[10px] text-slate-200";

interface QuickOpenDialogProps {
  isApple: boolean;
  onChoose: (file: WorkspaceTreeFile) => void;
  onDismiss: () => void;
  /** Where focus goes when the dialog closes, ahead of the element that opened it. */
  returnFocusTo: RefObject<HTMLElement | null>;
}

function HighlightedText({ text, matches }: { text: string; matches: number[] }) {
  return highlightRuns(text, matches).map((run, index) =>
    run.matched ? (
      <span key={index} className="font-semibold text-sky-300">
        <LangText text={run.text} />
      </span>
    ) : (
      <LangText key={index} text={run.text} />
    ),
  );
}

function matchCountText(query: string, total: number): string {
  if (!query.trim()) return "";
  if (total === 0) return `No files match ${query.trim()}`;
  return total === 1 ? "1 file matches" : `${total} files match`;
}

/** The query-independent candidate list, re-prepared only when the file tree changes. */
function useQuickOpenCandidates(): QuickOpenCandidate[] {
  const files = useWorkspaceTreeFiles();
  return prepareQuickOpenCandidates(files);
}

/**
 * Go to File: a search field over the workspace's files, as VS Code's Cmd+P.
 * The field is a combobox whose listbox holds the ranked files; the arrow keys
 * move the active file and Enter opens it, while focus stays in the field.
 */
export default function QuickOpenDialog({
  isApple,
  onChoose,
  onDismiss,
  returnFocusTo,
}: QuickOpenDialogProps) {
  const candidates = useQuickOpenCandidates();
  const activeFilePath = useWorkspaceActiveFilePath();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const titleId = useId();
  const listboxId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const { results, total } = rankQuickOpenFiles(candidates, query);
  const selected = results.length ? Math.min(activeIndex, results.length - 1) : -1;
  const optionId = (path: string) => optionIdFor(listboxId, path);
  // String() tells the React Compiler the path is a primitive: a call it cannot
  // see into, given a value read out of `results`, would re-rank on every arrow.
  const activeId =
    selected >= 0 ? optionIdFor(listboxId, String(results[selected].file.path)) : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, query]);

  const wrap = (index: number) => (index + results.length) % results.length;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // A key that ends an input method's composition is the input method's.
    if (isImeComposingKey(event.nativeEvent)) return;
    if (event.key === "Enter") {
      if (selected < 0) return;
      event.preventDefault();
      onChoose(results[selected].file);
      return;
    }

    let next: number | null = null;
    if (event.key === "ArrowDown") next = wrap(selected + 1);
    else if (event.key === "ArrowUp") next = wrap(selected - 1);
    else if (event.key === "PageDown") next = Math.min(results.length - 1, selected + PAGE_SIZE);
    else if (event.key === "PageUp") next = Math.max(0, selected - PAGE_SIZE);
    // Pressing the shortcut again moves down, as in VS Code; so do Ctrl+N and
    // Ctrl+P on a Mac, where Ctrl is not the command key.
    else if (isGoToFileShortcut(event.nativeEvent, isApple)) next = wrap(selected + 1);
    else if (isApple && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === "n") next = wrap(selected + 1);
      else if (key === "p") next = wrap(selected - 1);
    }
    if (next === null) return;
    event.preventDefault();
    if (results.length) setActiveIndex(next);
  };

  // A press anywhere in the card but the field and Close keeps focus, and so
  // the arrows, Enter and typing, in the field. A press on the list itself (its
  // padding, or its scrollbar, overlay or classic) is left alone: Firefox drops
  // a scrollbar drag whose mousedown was prevented. Focus comes back on mouseup.
  const keepFocusInField = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest("input, button")) return;
    if (target.getAttribute("role") === "listbox") return;
    event.preventDefault();
  };

  const trimmedQuery = query.trim();

  return (
    <ModalShell
      maxWidthClassName="max-w-xl"
      labelledBy={titleId}
      onDismiss={onDismiss}
      returnFocusTo={returnFocusTo}
    >
      <div className="contents" onMouseDown={keepFocusInField}>
        <h2 id={titleId} className="sr-only">
          Go to file
        </h2>
        <div className="flex items-center gap-2 border-b border-slate-800 p-3">
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-2.5 text-slate-500"
            />
            {/* Not type="search": its searchbox role and native Escape-to-clear
              would fight the combobox and the dialog's Escape. */}
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label="Search files by name"
              placeholder="Search files by name"
              aria-expanded={results.length > 0}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              aria-describedby={hintId}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleKeyDown}
              className="h-9 w-full rounded-md border border-slate-700 bg-[#11141c] pl-9 pr-3 text-[13px] text-slate-100 placeholder:text-slate-400 focus:border-slate-500 focus:outline-hidden"
            />
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onDismiss}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* Mounted before the results and never re-created, so each new count is announced. */}
        <p role="status" className="sr-only">
          {matchCountText(query, total)}
        </p>

        {/* Always mounted, so aria-controls always names it. */}
        <ul
          role="listbox"
          id={listboxId}
          aria-label="Files"
          hidden={!results.length}
          onMouseUp={() => inputRef.current?.focus()}
          className="max-h-[min(60vh,28rem)] overflow-y-auto p-1.5"
        >
          {results.map((result, index) => {
            const isActive = index === selected;
            const isOpen = result.file.path === activeFilePath;
            return (
              <li
                key={result.file.path}
                id={optionId(result.file.path)}
                role="option"
                aria-selected={isActive}
                onClick={() => onChoose(result.file)}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] leading-5 ${
                  isActive
                    ? // The outline is transparent until forced colors draw it, where
                      // the background and the inset bar are dropped.
                      "bg-slate-800 text-white shadow-[inset_2px_0_0_#00bcff] outline-2 -outline-offset-2 outline-transparent"
                    : "text-slate-300 hover:bg-slate-800/70"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center"
                >
                  {getFileIcon(result.file)}
                </span>
                <span className="min-w-0 truncate font-medium">
                  <HighlightedText text={result.name} matches={result.nameMatches} />
                </span>
                {result.directory ? (
                  // The folder gives way first; the name is cut only when it alone does not fit.
                  <span className="min-w-0 shrink-999 truncate text-xs text-slate-300">
                    <span className="sr-only">, in </span>
                    <HighlightedText text={result.directory} matches={result.directoryMatches} />
                  </span>
                ) : null}
                {isOpen ? (
                  <span className="ml-auto shrink-0 text-[11px] text-slate-300">
                    <span className="sr-only">, </span>open
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        {trimmedQuery && !results.length ? (
          <p className="px-4 py-3 text-xs text-slate-300">No files match “{trimmedQuery}”.</p>
        ) : null}

        <p
          id={hintId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-800 px-4 py-2 text-[11px] text-slate-300"
        >
          <span>
            <kbd className={KBD_CLASS}>↑</kbd> <kbd className={KBD_CLASS}>↓</kbd> to move,{" "}
            <kbd className={KBD_CLASS}>Enter</kbd> to open, <kbd className={KBD_CLASS}>Esc</kbd> to
            close
          </span>
          {total > QUICK_OPEN_RESULT_LIMIT ? (
            <span className="ml-auto">
              Showing the first {QUICK_OPEN_RESULT_LIMIT} of {total}
            </span>
          ) : null}
        </p>
      </div>
    </ModalShell>
  );
}
