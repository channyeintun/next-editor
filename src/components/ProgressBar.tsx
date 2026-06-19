import React, { type MouseEvent, useRef, useState, useCallback, useEffect } from "react";

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
}

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
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragProgress, setDragProgress] = useState<number | null>(null);

  const calculateProgress = useCallback(
    (clientX: number): number => {
      if (!containerRef.current || !duration) return 0;
      const rect = containerRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const percentage = Math.max(0, Math.min(x / rect.width, 1));
      return percentage * 100;
    },
    [duration],
  );

  const calculateTime = useCallback(
    (clientX: number): number => {
      if (!containerRef.current || !duration) return 0;
      const rect = containerRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const percentage = Math.max(0, Math.min(x / rect.width, 1));
      return percentage * duration;
    },
    [duration],
  );

  const handleMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!onSeek || !duration) return;
      e.preventDefault();
      setIsDragging(true);
      setDragProgress(calculateProgress(e.clientX));
    },
    [onSeek, duration, calculateProgress],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: globalThis.MouseEvent) => {
      setDragProgress(calculateProgress(e.clientX));
    };

    const handleMouseUp = (e: globalThis.MouseEvent) => {
      if (onSeek && duration) {
        const targetTime = calculateTime(e.clientX);
        onSeek(Math.max(0, Math.min(targetTime, duration)));
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
    // If we just finished dragging, don't also trigger click
    if (isDragging) return;
    if (!onSeek || !duration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const targetTime = percentage * duration;

    onSeek(Math.max(0, Math.min(targetTime, duration)));
  };

  // Use drag progress while dragging, otherwise use actual progress
  const displayProgress = isDragging && dragProgress !== null ? dragProgress : progress;

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
    width: `${Math.max(0, Math.min(displayProgress, 100))}%`,
    height: "100%",
    backgroundColor: progressColor,
    borderRadius: "inherit",
  };

  const thumbStyle: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: `${Math.max(0, Math.min(displayProgress, 100))}%`,
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
        onMouseLeave={(e) => {
          // Return to original height
          e.currentTarget.style.height = height;
        }}
        role="progressbar"
        aria-valuenow={currentTime}
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-label="Playback progress"
      >
        <div className="next-editor-progress-bar" style={progressStyle} />
        <div className="next-editor-progress-thumb" style={thumbStyle} />
      </div>
    </>
  );
};

export default ProgressBar;
