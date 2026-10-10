import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Check,
  Eye,
  EyeOff,
  ImagePlus,
  ListMusic,
  MoreVertical,
  Pencil,
  Play,
  Trash2,
  X,
} from "lucide-react";
import {
  MAX_TITLE_CHARS,
  prepareThumbnail,
  THUMBNAIL_ACCEPT,
  useDeleteLesson,
  usePublishFromLibrary,
  useUnpublishLesson,
  useUpdateLessonName,
  useUpdateThumbnail,
  type OwnedLesson,
} from "@next-editor/infra";
import LangText from "@app/components/LangText";
import PopoverMenu from "@app/components/PopoverMenu";
import { resolveThumb } from "../lib/links";
import AddToPlaylistPopover from "./AddToPlaylistPopover";
import ThumbnailTile from "./ThumbnailTile";

type Confirming = "unpublish" | "delete" | null;

const ghostButton =
  "px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400 transition-colors hover:text-white disabled:cursor-default disabled:opacity-60";
const confirmButton =
  "rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-white hover:text-slate-950";

export default function MyLessonCard({ lesson }: { lesson: OwnedLesson }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [addingToPlaylist, setAddingToPlaylist] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleValue, setTitleValue] = useState(lesson.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleErrorId = useId();
  const thumbnailInputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const triggerRefocusPending = useRef(false);

  const publish = usePublishFromLibrary();
  const unpublish = useUnpublishLesson();
  const del = useDeleteLesson();
  const updateThumbnail = useUpdateThumbnail();
  const updateName = useUpdateLessonName();

  const isPublished = lesson.status === "published";
  const isBusy =
    publish.isPending ||
    unpublish.isPending ||
    del.isPending ||
    updateThumbnail.isPending ||
    updateName.isPending;
  const hasMutationError =
    publish.isError || unpublish.isError || del.isError || updateThumbnail.isError;
  // A thumbnail upload can still be running when a rename is saved, so both
  // can show at once.
  const pendingMessages = [
    updateThumbnail.isPending && "Updating thumbnail…",
    updateName.isPending && "Updating lesson name…",
  ].filter((message) => message !== false);

  // Menu actions, the confirmations, the rename field and the playlist
  // popover all unmount the control that had focus, which would drop focus to
  // <body>. Each hands focus back to the options trigger instead. The trigger
  // is disabled while a mutation is in flight (a publish, a saved rename) and
  // focus() on a disabled button does nothing, so a request made while busy
  // is honoured once the trigger is enabled again — unless the user has moved
  // focus somewhere else in the meantime.
  const focusTrigger = () => {
    triggerRefocusPending.current = true;
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!triggerRefocusPending.current || isBusy) return;
    triggerRefocusPending.current = false;
    if (document.activeElement === null || document.activeElement === document.body) {
      triggerRef.current?.focus();
    }
  });

  const closeRename = () => {
    setRenaming(false);
    focusTrigger();
  };

  const handleSelectThumbnail = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    // Clear the value so re-selecting the same file fires another change event.
    input.value = "";
    if (!file) return;

    // Every rejection, including an image `createImageBitmap` can't read, lands
    // here before `mutate`, so `updateThumbnail.isError` never lights up for
    // it: this message is the only thing that tells the user the pick failed.
    const prepared = await prepareThumbnail(file);
    if ("error" in prepared) {
      setThumbnailError(prepared.error);
      return;
    }
    setThumbnailError(null);
    updateThumbnail.mutate({ lessonId: lesson.id, thumbnail: prepared.file });
  };

  const submitRename = () => {
    const trimmed = titleValue.trim();
    if (!trimmed) {
      setTitleError("Lesson name can't be empty.");
      return;
    }
    if (trimmed === lesson.title) {
      closeRename();
      return;
    }
    setTitleError(null);
    updateName.mutate(
      { lessonId: lesson.id, title: trimmed },
      {
        onSuccess: closeRename,
        onError: () => setTitleError("Couldn't update the lesson name — try again."),
      },
    );
  };

  // Only a published lesson has a page to open: the public lesson routes never
  // serve drafts, so a draft card stays a plain (non-link) card.
  const href = isPublished ? `/learn/${lesson.slug}` : null;

  // The badges repeat what the heading's hidden text says, so they are hidden
  // from assistive tech; inside the thumbnail link they would be anyway.
  const thumbnail = (
    <>
      <ThumbnailTile
        src={resolveThumb(lesson.thumbnail)}
        // A draft's image is decorative: the title is the heading right below.
        alt={href ? lesson.title : ""}
        fallbackIcon={Play}
        hoverScale={href !== null}
      />
      <span
        aria-hidden="true"
        className={`absolute left-2 top-2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          isPublished ? "bg-emerald-500/90 text-slate-950" : "bg-black/80 text-slate-300"
        }`}
      >
        {isPublished ? "Published" : "Draft"}
      </span>
      {lesson.duration && (
        <span
          aria-hidden="true"
          className="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white"
        >
          {lesson.duration}
        </span>
      )}
    </>
  );

  return (
    <div className="group">
      {/* Same shape as the gallery's LessonCard: the thumbnail and the title
          both open the lesson. The thumbnail link is a pointer target only —
          out of the tab order and the accessibility tree — so keyboard and
          screen-reader users get one stop for the lesson (the title), then
          one for its options. The options button sits in the title row, not
          on the thumbnail, so no control is nested inside the link. */}
      {href ? (
        <Link
          to={href}
          tabIndex={-1}
          aria-hidden="true"
          className="relative block aspect-video overflow-hidden rounded-xl bg-slate-900"
        >
          {thumbnail}
        </Link>
      ) : (
        <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-900">
          {thumbnail}
        </div>
      )}

      <div className="mt-3 space-y-2">
        {/* Always mounted, and first, so screen readers announce the progress
            text as it changes (a region mounted together with its text is not
            reliably read). The visible lines below repeat it, hidden from
            assistive tech so it is not read twice. */}
        <p role="status" className="sr-only">
          {pendingMessages.join(" ")}
        </p>
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  aria-label="Lesson name"
                  aria-invalid={titleError ? true : undefined}
                  aria-describedby={titleError ? titleErrorId : undefined}
                  value={titleValue}
                  onChange={(e) => setTitleValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitRename();
                    if (e.key === "Escape") closeRename();
                  }}
                  maxLength={MAX_TITLE_CHARS}
                  disabled={updateName.isPending}
                  className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm text-white focus:border-pinata-purple/60 disabled:opacity-60"
                />
                <button
                  type="button"
                  aria-label="Save lesson name"
                  onClick={submitRename}
                  disabled={updateName.isPending}
                  className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
                >
                  <Check className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Cancel rename"
                  onClick={closeRename}
                  disabled={updateName.isPending}
                  className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
                >
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <h3 className="text-sm font-semibold leading-snug text-white">
                {/* The two-line clamp (overflow: hidden) sits on the link, not
                    the h3, so an ancestor's overflow cannot clip the focus ring. */}
                {href ? (
                  <Link
                    to={href}
                    className="line-clamp-2 rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-pinata-purple focus-visible:ring-offset-2 focus-visible:ring-offset-[#11141c]"
                  >
                    <LangText text={lesson.title} />
                  </Link>
                ) : (
                  <span className="line-clamp-2">
                    <LangText text={lesson.title} />
                  </span>
                )}
                {/* The status and duration badges are hidden from assistive
                    tech, so the heading carries them, after the link: the
                    link's name stays exactly its visible title. */}
                <span className="sr-only">
                  {isPublished ? ", published" : ", draft"}
                  {lesson.duration ? `, duration ${lesson.duration}` : ""}
                </span>
              </h3>
            )}
          </div>

          <div className="relative shrink-0">
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              disabled={isBusy}
              aria-label="Lesson options"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="-mr-1.5 -mt-1.5 flex size-8 items-center justify-center rounded-full text-slate-300 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-60"
            >
              <MoreVertical className="size-4" />
            </button>

            <PopoverMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              triggerRef={triggerRef}
              className="absolute right-0 z-50 mt-2 w-48 overflow-hidden rounded-xl border border-white/10 bg-[#11141c] text-left shadow-xl"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  if (isPublished) {
                    setConfirming("unpublish");
                  } else {
                    publish.mutate(lesson.id);
                    focusTrigger();
                  }
                }}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white transition-colors hover:bg-white/10"
              >
                {isPublished ? (
                  <EyeOff className="size-4 text-slate-400" />
                ) : (
                  <Eye className="size-4 text-slate-400" />
                )}
                {isPublished ? "Unpublish" : "Publish"}
              </button>
              {isPublished && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setAddingToPlaylist(true);
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white transition-colors hover:bg-white/10"
                >
                  <ListMusic className="size-4 text-slate-400" />
                  Add to playlist
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  // Focus the trigger before the picker opens, so focus is on
                  // it (not <body>) when the picker closes.
                  triggerRef.current?.focus();
                  thumbnailInputRef.current?.click();
                }}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white transition-colors hover:bg-white/10"
              >
                <ImagePlus className="size-4 text-slate-400" />
                Update thumbnail
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setTitleValue(lesson.title);
                  setTitleError(null);
                  setRenaming(true);
                }}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white transition-colors hover:bg-white/10"
              >
                <Pencil className="size-4 text-slate-400" />
                Update lesson name
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirming("delete");
                }}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-rose-300 transition-colors hover:bg-white/10"
              >
                <Trash2 className="size-4" />
                Delete
              </button>
            </PopoverMenu>

            {addingToPlaylist && (
              <AddToPlaylistPopover
                lesson={lesson}
                onClose={() => {
                  setAddingToPlaylist(false);
                  focusTrigger();
                }}
              />
            )}

            <input
              ref={thumbnailInputRef}
              type="file"
              accept={THUMBNAIL_ACCEPT}
              className="hidden"
              onChange={handleSelectThumbnail}
            />
          </div>
        </div>

        {thumbnailError ? (
          <p role="alert" className="text-xs text-rose-300">
            {thumbnailError}
          </p>
        ) : null}
        {titleError ? (
          <p id={titleErrorId} role="alert" className="text-xs text-rose-300">
            {titleError}
          </p>
        ) : null}
        {!thumbnailError && !titleError && hasMutationError && confirming === null ? (
          <p role="alert" className="text-xs text-rose-300">
            Something went wrong — try again.
          </p>
        ) : null}
        {pendingMessages.map((message) => (
          <p key={message} aria-hidden="true" className="text-xs text-slate-400">
            {message}
          </p>
        ))}

        {confirming === "unpublish" ? (
          <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 p-2.5">
            <p className="text-xs text-slate-300">
              Unpublish this lesson? It’ll disappear from the public gallery and any shared link
              will stop working. You can publish it again anytime.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => {
                  setConfirming(null);
                  focusTrigger();
                }}
                className={ghostButton}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(null);
                  unpublish.mutate(lesson.id);
                  focusTrigger();
                }}
                className={confirmButton}
              >
                Confirm
              </button>
            </div>
          </div>
        ) : confirming === "delete" ? (
          <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5">
            <p className="text-xs text-slate-300">
              Delete this lesson permanently? This can’t be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => {
                  setConfirming(null);
                  focusTrigger();
                }}
                className={ghostButton}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(null);
                  del.mutate(lesson.id);
                  focusTrigger();
                }}
                className="rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-700"
              >
                Delete
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
