import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  ArrowDownAZ,
  GripVertical,
  X,
} from "lucide-react";
import { useModalFocus } from "@app/hooks/useModalFocus";
import LangText from "@app/components/LangText";
import HoverRing from "@app/components/hoverRing/HoverRing";
import {
  useAddLessonsToPlaylist,
  useMyLessons,
  usePlaylistLessons,
  useRemoveLessonFromPlaylist,
  useSavePlaylistOrder,
  type OwnedLesson,
  type OwnedPlaylist,
} from "@next-editor/infra";
import { moveItem, orderMembers, sortByTitle } from "./playlistOrder";

// Everything for one playlist at a time, opened via a card's "Manage lessons"
// menu item. A real modal (matching infra/client/upload/UploadLessonModal's
// backdrop/card shell), not an inline panel — a compact thumbnail card has no
// room for this.
//
// Two views. "Lessons" orders and removes members: drag a row, move it a step
// or to either end, or sort the whole playlist by title, and each new order
// shows at once and saves in the background (useSavePlaylistOrder). "Add
// lessons" picks many of the author's published lessons at once — a whole
// course with one filter and "Select all" — and adds them in one request. A
// lesson's own menu ("Add to playlist") still adds that one lesson.
export default function PlaylistManagePanel({
  playlist,
  onClose,
}: {
  playlist: OwnedPlaylist;
  onClose: () => void;
}) {
  const [view, setView] = useState<"lessons" | "add">("lessons");
  const [actionError, setActionError] = useState<string | null>(null);
  // Read out by the one status region below: what a move, sort or add did.
  const [announcement, setAnnouncement] = useState("");
  // Scopes the remove-busy state to the one lesson actually being removed —
  // the mutation hook below is shared across every row in this panel, so its
  // own isPending would otherwise disable every row's button while any one
  // of them is in flight.
  const [removingLessonId, setRemovingLessonId] = useState<string | null>(null);
  // The order this panel set, shown at once while it saves; null shows the
  // server's order.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  // Focus moves in on open (to Close), Tab wraps inside the card, Escape
  // closes, and focus goes back to the card's options trigger on close.
  const { onKeyDown } = useModalFocus(cardRef, { active: true, onEscape: onClose });

  const removeLesson = useRemoveLessonFromPlaylist();
  const saveOrder = useSavePlaylistOrder();

  // Owner-scoped membership (id/title/status per member), NOT the public
  // by-slug read: that one filters to published lessons, which would leave a
  // member that was unpublished after being added invisible here — stuck in
  // the playlist with no way to remove it, while the card badge still counts
  // it. Unpublished members render below with a "draft" tag instead.
  const { data: members, isPending: membersPending } = usePlaylistLessons(playlist.id);
  const orderedMembers = orderMembers(members ?? [], localOrder);

  // Still closes on Escape when focus has fallen to <body> (a removed row's
  // button unmounts), where the card's own handler above cannot hear it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const applyOrder = (next: OwnedLesson[], message: string) => {
    const lessonIds = next.map((lesson) => lesson.id);
    setActionError(null);
    setLocalOrder(lessonIds);
    setAnnouncement(message);
    saveOrder(playlist.id, lessonIds).catch(() => {
      // Back to what the server holds (the hook refetches it).
      setLocalOrder(null);
      setActionError("Couldn't save the new order — try again.");
    });
  };

  const moveMember = (from: number, to: number) => {
    if (to === from || to < 0 || to >= orderedMembers.length) return;
    const lesson = orderedMembers[from];
    applyOrder(
      moveItem(orderedMembers, from, to),
      `Moved ${lesson.title} to position ${to + 1} of ${orderedMembers.length}.`,
    );
  };

  const removeMember = (lessonId: string) => {
    setActionError(null);
    setRemovingLessonId(lessonId);
    removeLesson.mutate(
      { playlistId: playlist.id, lessonId },
      {
        onSettled: () => setRemovingLessonId(null),
        onError: () => setActionError("Couldn't remove that lesson — try again."),
      },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[#0b0d12]/62 px-4 py-16 backdrop-blur-[2px]"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
          <h3 id={titleId} className="min-w-0 truncate text-sm font-semibold text-white">
            Manage &ldquo;
            <LangText text={playlist.title} />
            &rdquo;
          </h3>
          <button
            type="button"
            autoFocus
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:text-white"
          >
            <X className="size-4" />
            <HoverRing />
          </button>
        </div>

        <div role="tablist" aria-label="Playlist view" className="flex gap-1 px-5 pt-4">
          {(["lessons", "add"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`${titleId}-tab-${tab}`}
              aria-selected={view === tab}
              aria-controls={`${titleId}-panel-${tab}`}
              onClick={() => {
                setView(tab);
                setActionError(null);
              }}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                view === tab ? "bg-white/10 text-white" : "text-slate-400 hover:text-white"
              }`}
            >
              {tab === "lessons" ? `Lessons (${orderedMembers.length})` : "Add lessons"}
              <HoverRing />
            </button>
          ))}
        </div>

        {/* One persistent region, never remounted with its text. */}
        <p role="status" className="sr-only">
          {announcement}
        </p>

        <div
          role="tabpanel"
          id={`${titleId}-panel-${view}`}
          aria-labelledby={`${titleId}-tab-${view}`}
          className="max-h-[60vh] overflow-y-auto p-5"
        >
          {actionError && (
            <p role="alert" className="mb-2 text-xs text-rose-300">
              {actionError}
            </p>
          )}

          {view === "lessons" ? (
            <MemberList
              members={orderedMembers}
              pending={membersPending}
              removingLessonId={removingLessonId}
              onMove={moveMember}
              onSortByTitle={() =>
                applyOrder(sortByTitle(orderedMembers), "Sorted the playlist by title.")
              }
              onRemove={removeMember}
            />
          ) : (
            <AddLessons
              playlistId={playlist.id}
              memberIds={new Set((members ?? []).map((lesson) => lesson.id))}
              onAdded={(message) => {
                setAnnouncement(message);
                setView("lessons");
              }}
              onError={setActionError}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const ICON_BUTTON =
  "rounded-md p-1 text-slate-400 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30";

function MemberList({
  members,
  pending,
  removingLessonId,
  onMove,
  onSortByTitle,
  onRemove,
}: {
  members: OwnedLesson[];
  pending: boolean;
  removingLessonId: string | null;
  onMove: (from: number, to: number) => void;
  onSortByTitle: () => void;
  onRemove: (lessonId: string) => void;
}) {
  // The row being dragged, and where it would land: before or after a row.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ index: number; after: boolean } | null>(null);

  if (pending) return <p className="text-xs text-slate-400">Loading…</p>;
  if (members.length === 0) {
    return (
      <p className="text-xs text-slate-400">
        No lessons yet. Add some from &ldquo;Add lessons&rdquo;.
      </p>
    );
  }

  const dropTargetOf = (event: DragEvent<HTMLLIElement>, index: number) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { index, after: event.clientY > box.top + box.height / 2 };
  };

  const finishDrop = () => {
    if (dragIndex !== null && dropAt) {
      // Landing after a row below the dragged one is one place earlier once
      // the dragged row has left its old place.
      const target = dropAt.index + (dropAt.after ? 1 : 0);
      onMove(dragIndex, target > dragIndex ? target - 1 : target);
    }
    setDragIndex(null);
    setDropAt(null);
  };

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          Drag a lesson, or use the arrows. Changes save as you go.
        </p>
        <button
          type="button"
          onClick={onSortByTitle}
          disabled={members.length < 2}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-60"
        >
          <ArrowDownAZ aria-hidden="true" className="size-3.5" />
          Sort by title
          <HoverRing />
        </button>
      </div>
      <ol className="space-y-1">
        {members.map((lesson, index) => {
          const last = members.length - 1;
          const indicator =
            dropAt?.index === index && dragIndex !== null && dragIndex !== index
              ? dropAt.after
                ? "shadow-[inset_0_-2px_0_0_rgb(125,211,252)]"
                : "shadow-[inset_0_2px_0_0_rgb(125,211,252)]"
              : "";
          return (
            <li
              key={lesson.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                // Firefox starts a drag only once it carries data.
                event.dataTransfer.setData("text/plain", lesson.id);
                setDragIndex(index);
              }}
              onDragOver={(event) => {
                if (dragIndex === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const next = dropTargetOf(event, index);
                if (next.index !== dropAt?.index || next.after !== dropAt?.after) setDropAt(next);
              }}
              onDrop={(event) => {
                event.preventDefault();
                finishDrop();
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setDropAt(null);
              }}
              className={`flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-sm ${indicator} ${
                dragIndex === index ? "opacity-50" : ""
              }`}
            >
              <GripVertical
                aria-hidden="true"
                className="size-3.5 shrink-0 cursor-grab text-slate-500"
              />
              <span className="w-6 shrink-0 text-right text-xs tabular-nums text-slate-400">
                {index + 1}
              </span>
              <span
                className={`min-w-0 flex-1 truncate ${
                  lesson.status === "published" ? "text-slate-300" : "text-slate-400"
                }`}
              >
                <LangText text={lesson.title} />
                {lesson.status !== "published" && (
                  <span
                    className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400"
                    title="Unpublished — hidden from the public playlist page until published again"
                  >
                    Draft
                  </span>
                )}
              </span>
              <span className="flex shrink-0">
                <button
                  type="button"
                  aria-label="Move to top"
                  title="Move to top"
                  disabled={index === 0}
                  onClick={() => onMove(index, 0)}
                  className={ICON_BUTTON}
                >
                  <ArrowUpToLine className="size-3.5" />
                  <HoverRing />
                </button>
                <button
                  type="button"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => onMove(index, index - 1)}
                  className={ICON_BUTTON}
                >
                  <ArrowUp className="size-3.5" />
                  <HoverRing />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={index === last}
                  onClick={() => onMove(index, index + 1)}
                  className={ICON_BUTTON}
                >
                  <ArrowDown className="size-3.5" />
                  <HoverRing />
                </button>
                <button
                  type="button"
                  aria-label="Move to bottom"
                  title="Move to bottom"
                  disabled={index === last}
                  onClick={() => onMove(index, last)}
                  className={ICON_BUTTON}
                >
                  <ArrowDownToLine className="size-3.5" />
                  <HoverRing />
                </button>
              </span>
              <button
                type="button"
                disabled={removingLessonId === lesson.id}
                onClick={() => onRemove(lesson.id)}
                className="shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-60"
              >
                Remove
                <HoverRing />
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function AddLessons({
  playlistId,
  memberIds,
  onAdded,
  onError,
}: {
  playlistId: string;
  memberIds: ReadonlySet<string>;
  onAdded: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const { data: myLessons, isPending } = useMyLessons();
  const addLessons = useAddLessonsToPlaylist();

  // Only published lessons can join a playlist (the server checks it too).
  const candidates = sortByTitle(
    (myLessons ?? []).filter(
      (lesson) => lesson.status === "published" && !memberIds.has(lesson.id),
    ),
  );
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? candidates.filter((lesson) => lesson.title.toLowerCase().includes(needle))
    : candidates;
  const shownSelected = shown.filter((lesson) => selected.has(lesson.id)).length;
  // Added in the order shown — by title — so a course goes in numbered.
  const toAdd = candidates.filter((lesson) => selected.has(lesson.id));

  const toggle = (ids: readonly string[], on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const add = () => {
    onError(null);
    addLessons.mutate(
      { playlistId, lessonIds: toAdd.map((lesson) => lesson.id) },
      {
        onSuccess: ({ added, alreadyAdded, notEligible }) => {
          setSelected(new Set());
          const skipped = alreadyAdded.length + notEligible.length;
          onAdded(
            `Added ${added.length} ${added.length === 1 ? "lesson" : "lessons"}${
              skipped > 0 ? `; ${skipped} skipped (already in the playlist or not published)` : ""
            }.`,
          );
        },
        onError: () => onError("Couldn't add those lessons — try again."),
      },
    );
  };

  if (isPending) return <p className="text-xs text-slate-400">Loading…</p>;
  if (candidates.length === 0) {
    return (
      <p className="text-xs text-slate-400">
        Every one of your published lessons is already in this playlist.
      </p>
    );
  }

  return (
    <>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter your published lessons"
        aria-label="Filter your published lessons"
        className="w-full rounded-lg border border-white/10 bg-[#0f1219] px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-400 focus:border-sky-400/60 focus:outline-none"
      />
      <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-slate-300">
        <input
          type="checkbox"
          checked={shown.length > 0 && shownSelected === shown.length}
          ref={(input) => {
            if (input) input.indeterminate = shownSelected > 0 && shownSelected < shown.length;
          }}
          disabled={shown.length === 0}
          onChange={(event) =>
            toggle(
              shown.map((lesson) => lesson.id),
              event.target.checked,
            )
          }
          className="size-3.5 accent-sky-500"
        />
        Select all {shown.length} shown
      </label>
      <ul className="mt-2 space-y-0.5">
        {shown.map((lesson) => (
          <li key={lesson.id}>
            <label className="flex items-center gap-2 rounded-md px-1 py-0.5 text-sm text-slate-300 hover:bg-white/5">
              <input
                type="checkbox"
                checked={selected.has(lesson.id)}
                onChange={(event) => toggle([lesson.id], event.target.checked)}
                className="size-3.5 shrink-0 accent-sky-500"
              />
              <span className="min-w-0 truncate">
                <LangText text={lesson.title} />
              </span>
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="text-xs text-slate-400">No lesson matches.</li>}
      </ul>
      <div className="sticky bottom-0 -mx-5 -mb-5 mt-3 flex items-center justify-between gap-3 border-t border-white/10 bg-[#151821] px-5 py-3">
        <span className="text-xs text-slate-400">
          They go to the end of the playlist, by title.
        </span>
        <button
          type="button"
          onClick={add}
          disabled={toAdd.length === 0 || addLessons.isPending}
          className="shrink-0 rounded-full bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
        >
          {addLessons.isPending
            ? "Adding…"
            : `Add ${toAdd.length} ${toAdd.length === 1 ? "lesson" : "lessons"}`}
          <HoverRing />
        </button>
      </div>
    </>
  );
}
