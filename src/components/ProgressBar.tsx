import React, { type MouseEvent } from 'react';

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
  width = '100%',
  height = '2px',
  backgroundColor = '#475569',
  progressColor = '#3b82f6',
  onSeek,
  className = '',
  style = {},
}) => {
  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onSeek || !duration) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const targetTime = percentage * duration;
    
    onSeek(Math.max(0, Math.min(targetTime, duration)));
  };

  const containerStyle: React.CSSProperties = {
    width,
    height,
    backgroundColor,
    cursor: 'pointer',
    position: 'relative',
    borderRadius: '4px',
    overflow: 'hidden',
    transition: 'height 150ms ease',
    ...style,
  };

  const progressStyle: React.CSSProperties = {
    width: `${Math.max(0, Math.min(progress, 100))}%`,
    height: '100%',
    backgroundColor: progressColor,
    borderRadius: 'inherit',
    transition: 'width 0.1s ease-out',
  };

  return (
    <div
      className={`scrimba-progress-container ${className}`}
      style={containerStyle}
      onClick={handleClick}
      onMouseEnter={(e) => {
        // Grow height on hover like the original
        e.currentTarget.style.height = '6px';
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
      <div
        className="scrimba-progress-bar"
        style={progressStyle}
      />
    </div>
  );
};

export default ProgressBar;