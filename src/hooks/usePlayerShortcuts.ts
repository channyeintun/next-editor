import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { RecordingChapter } from "../core/src";
import { findChapterIndexAt } from "../core/src/utils/chapters";
import { isPlayerKeyTarget } from "../core/src/utils/playerKeyTargets";
import { resumeSharedAudioContext } from "../core/src/utils/audioContext";
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from "../core/src/machine/playbackValues";
import {
  useNextEditorActions,
  useNextEditorMetadata,
  useNextEditorPlayback,
} from "./useNextEditorContext";
import { useCaptionStore, useCaptionStoreTrigger } from "./useCaptionStore";
import { useApplySpeedAndVolume } from "./usePlaybackSettings";
import { playbackSettingsStore } from "../stores/playbackSettingsStore";

// ============================================================================
// Keyboard control of the player, as in video players: play and pause, seek,
// step, speed, chapters, mute and captions. Keys go to the player only when
// nothing else wants them: typing in the editor, the terminal, the whiteboard
// or a field, a dialog, and a key another handler already took all win.
// The letter, number and punctuation keys can be turned off in the player's
// settings ("Single-key shortcuts", WCAG 2.1.4); Space, the arrows, Home and
// End keep working.
// ============================================================================

const SEEK_MS = 5_000;
const JUMP_MS = 10_000;
const STEP_MS = 1_000;
const SPEED_STEP = 0.25;
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

/** A printable key (a letter, a number or punctuation), which the "Single-key shortcuts"
 *  setting turns off. Space is not one: it stays the play and pause key. */
export const isCharacterKey = (key: string): boolean => key.length === 1 && key !== " ";

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
  const { play, pause, seekTo } = useNextEditorActions();
  const { isPlaying, isRecording, currentRecording } = useNextEditorMetadata();
  const { editorActor, playbackSpeed, volume, durationMs } = useNextEditorPlayback();
  const { enabled: captionsEnabled } = useCaptionStore();
  const captionTrigger = useCaptionStoreTrigger();
  const { applySpeed, applyVolume } = useApplySpeedAndVolume();
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

  // Carries out a shortcut with the player as it is now. An Effect Event, so the listener below
  // is added once per loaded recording instead of again on every change these values see.
  const runShortcut = useEffectEvent((shortcut: PlayerShortcut): boolean => {
    if (!currentRecording) return false;
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
      applySpeed(speed);
      show(formatSpeed(speed));
    };

    switch (shortcut.type) {
      case "togglePlay":
        // Pressed on the page during playback, Space never gets here: the editor's own
        // listener pauses on it first (useNextEditor, defaultPrevented), so this only ever
        // plays for Space. Typing and pressable targets keep their Space either way.
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
        const speed = Math.min(
          MAX_PLAYBACK_SPEED,
          Math.max(MIN_PLAYBACK_SPEED, playbackSpeed + shortcut.delta),
        );
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
          applyVolume(0);
          show("Muted");
        } else {
          applyVolume(unmutedVolumeRef.current || 1);
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
  });

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // A key another handler took (the editor's Space-to-pause, the slides' arrows) is theirs.
      // Held Space would flip between play and pause on every repeat.
      if (event.defaultPrevented || (event.repeat && event.key === " ")) return;
      // Read here, not from a hook, so the setting changes without adding the listener again.
      if (
        isCharacterKey(event.key) &&
        !playbackSettingsStore.getSnapshot().context.characterShortcuts
      )
        return;
      const shortcut = playerShortcutFor(event);
      if (!shortcut || !isPlayerKeyTarget(event.target, event.key)) return;
      if (runShortcut(shortcut)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  return {
    feedback: active ? feedback : null,
    helpOpen: active && helpOpen,
    closeHelp: () => setHelpOpen(false),
    openHelp: () => setHelpOpen(true),
  };
}
