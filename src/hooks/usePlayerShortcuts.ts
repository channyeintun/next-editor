import { useEffect, useRef, useState } from "react";
import type { RecordingChapter } from "../core/src";
import { findChapterIndexAt } from "../core/src/utils/chapters";
import { resumeSharedAudioContext } from "../core/src/utils/audioContext";
import {
  useNextEditorActions,
  useNextEditorMetadata,
  useNextEditorPlayback,
} from "./useNextEditorContext";
import { useCaptionStore, useCaptionStoreTrigger } from "./useCaptionStore";
import { usePlaybackSettingsTrigger } from "./usePlaybackSettings";

// ============================================================================
// Keyboard control of the player, as in video players: play and pause, seek,
// step, speed, chapters, mute and captions. Keys go to the player only when
// nothing else wants them: typing in the editor, the terminal, the whiteboard
// or a field, a dialog, and a key another handler already took all win.
// ============================================================================

const SEEK_MS = 5_000;
const JUMP_MS = 10_000;
const STEP_MS = 1_000;
const SPEED_STEP = 0.25;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;
/** Further into a chapter than this, "previous chapter" goes back to its start first. */
const CHAPTER_RESTART_MS = 2_000;
const FEEDBACK_MS = 900;

export type PlayerShortcut =
  | { type: "togglePlay" }
  | { type: "seekBy"; ms: number }
  | { type: "stepBy"; ms: number }
  | { type: "seekToFraction"; fraction: number }
  | { type: "seekToEnd" }
  | { type: "speedBy"; delta: number }
  | { type: "chapter"; direction: -1 | 1 }
  | { type: "toggleMute" }
  | { type: "toggleCaptions" }
  | { type: "toggleHelp" };

/** The keys, as the help lists them. */
export const PLAYER_SHORTCUTS: ReadonlyArray<{ keys: readonly string[]; action: string }> = [
  { keys: ["Space", "K"], action: "Play or pause" },
  { keys: ["←", "→"], action: "Back or forward 5 seconds" },
  { keys: ["J", "L"], action: "Back or forward 10 seconds" },
  { keys: [",", "."], action: "Pause and step back or forward 1 second" },
  { keys: ["<", ">"], action: "Slower or faster" },
  { keys: ["[", "]"], action: "Previous or next chapter" },
  { keys: ["0–9"], action: "Jump to 0%–90% of the lesson" },
  { keys: ["Home", "End"], action: "Jump to the start or the end" },
  { keys: ["M"], action: "Mute or unmute" },
  { keys: ["C"], action: "Captions on or off" },
  { keys: ["?"], action: "Show or hide these shortcuts" },
];

type KeyPress = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">;

/** The player action a key asks for, or null for a key the player leaves alone. */
export function playerShortcutFor(event: KeyPress): PlayerShortcut | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case " ":
    case "k":
    case "K":
      return { type: "togglePlay" };
    case "ArrowLeft":
      return { type: "seekBy", ms: -SEEK_MS };
    case "ArrowRight":
      return { type: "seekBy", ms: SEEK_MS };
    case "j":
    case "J":
      return { type: "seekBy", ms: -JUMP_MS };
    case "l":
    case "L":
      return { type: "seekBy", ms: JUMP_MS };
    case ",":
      return { type: "stepBy", ms: -STEP_MS };
    case ".":
      return { type: "stepBy", ms: STEP_MS };
    case "<":
      return { type: "speedBy", delta: -SPEED_STEP };
    case ">":
      return { type: "speedBy", delta: SPEED_STEP };
    case "[":
      return { type: "chapter", direction: -1 };
    case "]":
      return { type: "chapter", direction: 1 };
    case "Home":
      return { type: "seekToFraction", fraction: 0 };
    case "End":
      return { type: "seekToEnd" };
    case "m":
    case "M":
      return { type: "toggleMute" };
    case "c":
    case "C":
      return { type: "toggleCaptions" };
    case "?":
      return { type: "toggleHelp" };
  }
  if (/^[0-9]$/.test(event.key))
    return { type: "seekToFraction", fraction: Number(event.key) / 10 };
  return null;
}

/** Places that take typing: the editor, the terminal, the whiteboard, and form fields. */
const TYPING_TARGETS =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], .monaco-editor, .xterm, .excalidraw";
/** Places with keys of their own: dialogs, menus, and widgets that arrow keys move. */
const OWN_KEYS_TARGETS =
  "[role='dialog'], [aria-modal='true'], [role='menu'], [role='listbox'], [role='slider'], [role='separator'], [role='tablist'], [role='tree'], [role='grid'], [role='radiogroup']";
/** Elements Space presses; the press is theirs. */
const PRESSABLE = "button, [role='button'], a[href], summary, [role='menuitem'], [role='tab']";

/** Whether a key pressed with focus on `target` belongs to the player. */
export function isPlayerKeyTarget(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(TYPING_TARGETS) || target.closest(OWN_KEYS_TARGETS)) return false;
  if ((target as HTMLElement).isContentEditable) return false;
  return !(key === " " && target.closest(PRESSABLE));
}

/** Where "previous" or "next chapter" goes from `time`, or null when there is none. */
export function chapterTarget(
  chapters: readonly RecordingChapter[],
  time: number,
  direction: -1 | 1,
): number | null {
  const index = findChapterIndexAt(chapters, time);
  if (direction === 1) return chapters[index + 1]?.time ?? null;
  const current = chapters[index];
  if (!current) return null;
  if (time - current.time > CHAPTER_RESTART_MS) return current.time;
  return chapters[index - 1]?.time ?? 0;
}

const formatSpeed = (speed: number) => `${speed}×`;

/**
 * Handles the player's keys while a recording is loaded (not while one is being made).
 * Returns the last action's feedback (shown briefly over the player) and the help's state.
 */
export function usePlayerShortcuts() {
  const { play, pause, seekTo, setPlaybackSpeed, setVolume } = useNextEditorActions();
  const { isPlaying, isRecording, currentRecording } = useNextEditorMetadata();
  const { editorActor, playbackSpeed, volume, durationMs } = useNextEditorPlayback();
  const { enabled: captionsEnabled } = useCaptionStore();
  const captionTrigger = useCaptionStoreTrigger();
  const playbackSettingsTrigger = usePlaybackSettingsTrigger();
  const [feedback, setFeedback] = useState<{ text: string; at: number } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // The level to unmute back to.
  const unmutedVolumeRef = useRef(1);

  const active = Boolean(currentRecording) && !isRecording;

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!active || !currentRecording) return;
    const duration = durationMs > 0 ? durationMs : currentRecording.duration;
    const chapters = currentRecording.chapters ?? [];
    const hasCaptions = Boolean(currentRecording.captions?.length);
    const show = (text: string) => setFeedback({ text, at: performance.now() });
    const now = () => editorActor.getSnapshot().context.timeline.currentTime;
    const seek = (time: number) => {
      resumeSharedAudioContext();
      seekTo(Math.min(Math.max(0, time), duration));
    };
    const setSpeed = (speed: number) => {
      setPlaybackSpeed(speed);
      playbackSettingsTrigger.setSpeed({ speed });
      show(formatSpeed(speed));
    };
    const setLevel = (level: number) => {
      setVolume(level);
      playbackSettingsTrigger.setVolume({ volume: level });
    };

    const run = (shortcut: PlayerShortcut): boolean => {
      switch (shortcut.type) {
        case "togglePlay":
          // Pressed during playback, Space never gets here: the editor's own listener
          // pauses on it first (useNextEditor), so this only ever plays for Space.
          resumeSharedAudioContext();
          if (isPlaying) pause();
          else play();
          return true;
        case "seekBy":
          seek(now() + shortcut.ms);
          show(`${shortcut.ms > 0 ? "+" : "−"}${Math.abs(shortcut.ms) / 1000} s`);
          return true;
        case "stepBy":
          if (isPlaying) pause();
          seek(now() + shortcut.ms);
          return true;
        case "seekToFraction":
          seek(duration * shortcut.fraction);
          return true;
        case "seekToEnd":
          seek(duration);
          return true;
        case "speedBy": {
          const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, playbackSpeed + shortcut.delta));
          if (speed !== playbackSpeed) setSpeed(speed);
          else show(formatSpeed(speed));
          return true;
        }
        case "chapter": {
          const target = chapterTarget(chapters, now(), shortcut.direction);
          if (target === null) return false;
          seek(target);
          const title = chapters[findChapterIndexAt(chapters, target)]?.title;
          if (title) show(title);
          return true;
        }
        case "toggleMute":
          if (volume > 0) {
            unmutedVolumeRef.current = volume;
            setLevel(0);
            show("Muted");
          } else {
            setLevel(unmutedVolumeRef.current || 1);
            show("Sound on");
          }
          return true;
        case "toggleCaptions":
          if (!hasCaptions) return false;
          captionTrigger.toggleEnabled();
          show(captionsEnabled ? "Captions off" : "Captions on");
          return true;
        case "toggleHelp":
          setHelpOpen((open) => !open);
          return true;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // A key another handler took (the editor's Space-to-pause, the slides' arrows) is theirs.
      // Held Space would flip between play and pause on every repeat.
      if (event.defaultPrevented || (event.repeat && event.key === " ")) return;
      const shortcut = playerShortcutFor(event);
      if (!shortcut || !isPlayerKeyTarget(event.target, event.key)) return;
      if (run(shortcut)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    active,
    currentRecording,
    durationMs,
    editorActor,
    isPlaying,
    playbackSpeed,
    volume,
    captionsEnabled,
    play,
    pause,
    seekTo,
    setPlaybackSpeed,
    setVolume,
    captionTrigger,
    playbackSettingsTrigger,
  ]);

  return {
    feedback: active ? feedback : null,
    helpOpen: active && helpOpen,
    closeHelp: () => setHelpOpen(false),
    openHelp: () => setHelpOpen(true),
  };
}
