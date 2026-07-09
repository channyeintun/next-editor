import { useLocation, useNavigate, useSearchParams } from "react-router";
import Editor from "@app/components/Editor";
import { playbackSettingsStore } from "@app/stores/playbackSettingsStore";
import type { Lesson } from "../types";
import { usePlaylist } from "../hooks/usePlaylists";
import Breadcrumb from "./Breadcrumb";

interface LessonDetailLocationState {
  /** Set by the "Continue to Next" auto-advance navigation so the next lesson
   *  always starts playing, regardless of the persisted Autoplay setting. */
  autoplay?: boolean;
}

export default function LessonDetail({ lesson }: { lesson: Lesson }) {
  const [searchParams] = useSearchParams();
  const listSlug = searchParams.get("list") ?? undefined;
  const { data: playlist } = usePlaylist(listSlug);
  const navigate = useNavigate();
  const location = useLocation();

  const currentIndex = playlist?.lessons.findIndex((l) => l.slug === lesson.slug) ?? -1;
  // A stale/foreign `?list=` (lesson isn't actually in the resolved playlist) is
  // treated as no playlist context at all.
  const playlistMode = Boolean(playlist && currentIndex !== -1);
  const nextLesson = playlistMode && playlist ? playlist.lessons[currentIndex + 1] : undefined;

  const handleEnded = () => {
    if (!nextLesson || !listSlug) return;
    const { continueToNext } = playbackSettingsStore.getSnapshot().context;
    if (!continueToNext) return;
    navigate(`/learn/${nextLesson.slug}?list=${listSlug}`, {
      state: { autoplay: true } satisfies LessonDetailLocationState,
    });
  };

  // Router state isn't part of the URL, so a refresh or a direct deep link never
  // force-plays — only an in-app auto-advance navigation sets it.
  const autoplayOverride = (location.state as LessonDetailLocationState | null)?.autoplay ?? false;

  return (
    <Editor
      readOnly
      recordingUrl={`/${lesson.ne}`}
      breadcrumb={<Breadcrumb title={lesson.title} />}
      playlistMode={playlistMode}
      onEnded={handleEnded}
      autoplayOverride={autoplayOverride}
    />
  );
}
