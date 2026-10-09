import React, { type KeyboardEvent, type MouseEvent, useRef, useState, useEffect } from "react";
import type { RecordingChapter } from "../core/src/types";
import { findChapterIndexAt } from "../core/src/utils/chapters";
import { formatPlaybackTime } from "../utils/formatPlaybackTime";

export interface ProgressBarProps {
  /**
   * Current progress percentage (0-100)
   */
  progress: number;
  /**
   * Duration in milliseconds
   */
  duration: number;
  /**
   * Current time in milliseconds
   */
  currentTime: number;
  /**
   * Width of the progress bar (CSS value)
   */
  width?: string;
  /**
   * Height of the progress bar (CSS value)
   */
  height?: string;
  /**
   * Height of the progress bar while hovered (CSS value)
   */
  hoverHeight?: string;
  /**
   * Background color of the progress bar
   */
  backgroundColor?: string;
  /**
   * Color of the progress indicator
   */
  progressColor?: string;
  /**
   * Callback when user clicks on the progress bar to seek
   */
  onSeek?: (targetTime: number) => void;
  /**
   * Custom CSS class name
   */
  className?: string;
  /**
   * Custom styles
   */
  style?: React.CSSProperties;
  /**
   * Chapters to mark on the bar, and to name in the hover tooltip
   */
  chapters?: readonly RecordingChapter[];
}

/**
 * Set on an ancestor, this CSS variable places the fill and thumb instead of `progress`
 * (as a percentage, e.g. "42%"), so a player can move them every frame without
 * re-rendering the bar. A drag still shows where the pointer is.
 */
export const LIVE_PROGRESS_VARIABLE = "--next-editor-live-progress";

/** How far each slider key moves a seekable bar, in milliseconds (as the player's ←/→). */
const SEEK_KEY_STEPS: ReadonlyMap<string, number> = new Map([
  ["ArrowLeft", -5_000],
  ["ArrowDown", -5_000],
  ["ArrowRight", 5_000],
  ["ArrowUp", 5_000],
  ["PageDown", -10_000],
  ["PageUp", 10_000],
]);

/**
 * Custom progress bar component that matches the demo functionality
 * Replaces input type=range which has display issues
 */
export const ProgressBar: React.FC<ProgressBarProps> = ({
  progress,
  duration,
  currentTime,
  width = "100%",
  height = "2px",
  hoverHeight = "6px",
  backgroundColor = "#475569",
  progressColor = "#3b82f6",
  onSeek,
  className = "",
  style = {},
  chapters,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // A bar that sets the position is a slider a keyboard can reach; without onSeek it only reports.
  const seekable = Boolean(onSeek) && duration > 0;
  const [isDragging, setIsDragging] = useState(false);
  const [dragProgress, setDragProgress] = useState<number | null>(null);
  // Where the pointer hovers, as a fraction of the bar, for the time/chapter tooltip.
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);

  // Set when a press-and-release has just seeked, so the click that follows it in the same
  // input task does not seek a second time.
  const seekedOnReleaseRef = useRef(false);

  // How far along the bar a pointer is, from 0 to 1 (null while there is no bar or length).
  const fractionAt = (clientX: number): number | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || !duration) return null;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const calculateProgress = (clientX: number): number => (fractionAt(clientX) ?? 0) * 100;

  const calculateTime = (clientX: number): number => (fractionAt(clientX) ?? 0) * duration;

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (!onSeek || !duration) return;
    e.preventDefault();
    seekedOnReleaseRef.current = false;
    setIsDragging(true);
    setDragProgress(calculateProgress(e.clientX));
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: globalThis.MouseEvent) => {
      setDragProgress(calculateProgress(e.clientX));
    };

    const handleMouseUp = (e: globalThis.MouseEvent) => {
      if (onSeek && duration) {
        onSeek(calculateTime(e.clientX));
        // The browser dispatches the click in the same task as this mouseup, so the
        // timeout only clears a flag no click consumed (the release was off the bar).
        seekedOnReleaseRef.current = true;
        window.setTimeout(() => {
          seekedOnReleaseRef.current = false;
        }, 0);
      }
      setIsDragging(false);
      setDragProgress(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, onSeek, duration, calculateProgress, calculateTime]);

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    // A press-and-release already seeked on mouseup. isDragging cannot tell: the native
    // mouseup's state update is flushed before the browser dispatches this click. A click
    // with no press before it (one assistive technology sends) still seeks here.
    if (seekedOnReleaseRef.current) {
      seekedOnReleaseRef.current = false;
      return;
    }
    if (!onSeek) return;
    const fraction = fractionAt(e.clientX);
    if (fraction === null) return;
    onSeek(fraction * duration);
  };

  // The slider's own keys. preventDefault keeps the player's window shortcuts (which also
  // seek on the arrows, Home and End) from acting on the same key press a second time.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onSeek || !seekable || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = SEEK_KEY_STEPS.get(e.key);
    let target: number | null = null;
    if (step !== undefined) target = currentTime + step;
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = duration;
    if (target === null) return;
    e.preventDefault();
    onSeek(Math.max(0, Math.min(target, duration)));
  };

  // Use drag progress while dragging, otherwise use actual progress
  const isShowingDrag = isDragging && dragProgress !== null;
  const displayProgress = isShowingDrag ? dragProgress : progress;
  const progressPercent = `${Math.max(0, Math.min(displayProgress, 100))}%`;
  const position = isShowingDrag
    ? progressPercent
    : `var(${LIVE_PROGRESS_VARIABLE}, ${progressPercent})`;

  const containerStyle: React.CSSProperties = {
    width,
    height,
    backgroundColor,
    cursor: "pointer",
    position: "relative",
    borderRadius: "4px",
    overflow: "visible",
    transition: "height 150ms ease",
    ...style,
  };

  // Add pseudo element for larger clickable area
  const containerWithPseudo = `
    .next-editor-progress-container::before {
      content: '';
      position: absolute;
      top: -8px;
      left: 0;
      right: 0;
      bottom: -8px;
      cursor: pointer;
    }
  `;

  const progressStyle: React.CSSProperties = {
    width: position,
    height: "100%",
    backgroundColor: progressColor,
    borderRadius: "inherit",
  };

  const thumbStyle: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: position,
    width: "12px",
    height: "12px",
    backgroundColor: progressColor,
    borderRadius: "50%",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    zIndex: 10,
    cursor: isDragging ? "grabbing" : "grab",
  };

  return (
    <>
      <style>{containerWithPseudo}</style>
      <div
        ref={containerRef}
        className={`next-editor-progress-container ${className}${isDragging ? " dragging" : ""}`}
        style={containerStyle}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onMouseEnter={(e) => {
          // Grow height on hover like the original
          e.currentTarget.style.height = hoverHeight;
        }}
        onMouseMove={(e) => {
          const fraction = fractionAt(e.clientX);
          if (fraction !== null) setHoverFraction(fraction);
        }}
        onMouseLeave={(e) => {
          // Return to original height
          e.currentTarget.style.height = height;
          setHoverFraction(null);
        }}
        // A slider when it seeks: focusable, with the arrows (5 s), Page Up/Down (10 s),
        // Home and End. Without onSeek it only reports, as a progressbar. Whole seconds,
        // read out as times.
        role={seekable ? "slider" : "progressbar"}
        tabIndex={seekable ? 0 : undefined}
        onKeyDown={seekable ? handleKeyDown : undefined}
        aria-valuenow={Math.floor(Math.min(currentTime, duration) / 1000)}
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration / 1000)}
        aria-valuetext={`${formatPlaybackTime(Math.min(currentTime, duration))} of ${formatPlaybackTime(duration)}`}
        aria-label="Playback progress"
      >
        <div className="next-editor-progress-bar" style={progressStyle} />
        {duration > 0
          ? chapters?.map((chapter) =>
              chapter.time > 0 && chapter.time < duration ? (
                // A notch in the bar where each chapter starts.
                <div
                  key={chapter.time}
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: `${(chapter.time / duration) * 100}%`,
                    width: "2px",
                    transform: "translateX(-1px)",
                    backgroundColor: "#11141c",
                    pointerEvents: "none",
                  }}
                />
              ) : null,
            )
          : null}
        <div className="next-editor-progress-thumb" style={thumbStyle} />
        {hoverFraction !== null && duration > 0 ? (
          <HoverTooltip
            fraction={hoverFraction}
            time={hoverFraction * duration}
            chapters={chapters}
          />
        ) : null}
      </div>
    </>
  );
};

function HoverTooltip({
  fraction,
  time,
  chapters,
}: {
  fraction: number;
  time: number;
  chapters?: readonly RecordingChapter[];
}) {
  const chapter = chapters?.length ? chapters[findChapterIndexAt(chapters, time)] : undefined;
  return (
    <div
      className="pointer-events-none absolute bottom-full mb-2.5 max-w-56 -translate-x-1/2 truncate rounded-md border border-slate-700 bg-[#151821] px-2 py-1 text-[11px] whitespace-nowrap text-slate-200 shadow-lg"
      style={{ left: `${Math.min(Math.max(fraction * 100, 6), 94)}%` }}
    >
      {chapter ? <span className="font-semibold">{chapter.title} · </span> : null}
      <span className="font-mono text-slate-400">{formatPlaybackTime(time)}</span>
    </div>
  );
}

export default ProgressBar;
