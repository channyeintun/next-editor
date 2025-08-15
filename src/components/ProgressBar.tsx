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
    overflow: 'visible',
    transition: 'height 150ms ease',
    ...style,
  };

  // Add pseudo element for larger clickable area
  const containerWithPseudo = `
    .scrimba-progress-container::before {
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
    width: `${Math.max(0, Math.min(progress, 100))}%`,
    height: '100%',
    backgroundColor: progressColor,
    borderRadius: 'inherit',
  };

  const thumbStyle: React.CSSProperties = {
    position: 'absolute',
    top: '50%',
    left: `${Math.max(0, Math.min(progress, 100))}%`,
    width: '12px',
    height: '12px',
    backgroundColor: progressColor,
    borderRadius: '50%',
    transform: 'translate(-50%, -50%)',
    pointerEvents: 'none',
    zIndex: 10,
  };

  return (
    <>
      <style>{containerWithPseudo}</style>
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
        <div
          className="scrimba-progress-thumb"
          style={thumbStyle}
        />
      </div>
    </>
  );
};

export default ProgressBar;