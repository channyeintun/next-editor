import { fromCallback, type ActorRefFrom } from 'xstate';

// ============================================================================
// Timeline Actor Types
// ============================================================================

export interface TimelineInput {
    /** Initial playback speed */
    speed: number;
    /** Total duration in milliseconds */
    duration: number;
    /** Starting position in milliseconds */
    startPosition: number;
}

export type TimelineEvent =
    | { type: 'START' }
    | { type: 'STOP' }
    | { type: 'PAUSE' }
    | { type: 'RESUME' }
    | { type: 'SEEK'; time: number }
    | { type: 'SET_SPEED'; speed: number };

export type TimelineEmit =
    | { type: 'TICK'; currentTime: number; timestamp: number }
    | { type: 'FINISHED' };

// ============================================================================
// Timeline Actor Logic
// ============================================================================

/**
 * Timeline actor that provides a single source of truth for playback time.
 * Uses requestAnimationFrame for smooth 60fps updates.
 * All time values are in milliseconds.
 */
export const timelineActor = fromCallback<TimelineEvent, TimelineInput, TimelineEmit>(
    ({ sendBack, receive, input }) => {
        let isRunning = false;
        let animationFrameId: number | null = null;

        // Timeline state
        let speed = input.speed;
        const duration = input.duration;
        let currentTime = input.startPosition;

        // Timing references
        let startedAt = 0;
        let accumulatedTime = input.startPosition;

        /**
         * Calculate the current timeline position
         */
        const getCurrentPosition = (): number => {
            if (!isRunning) return currentTime;

            const now = performance.now();
            const elapsed = (now - startedAt) * speed;
            return Math.min(accumulatedTime + elapsed, duration);
        };

        /**
         * Animation frame loop for smooth updates
         */
        const tick = () => {
            if (!isRunning) return;

            const position = getCurrentPosition();
            currentTime = position;

            // Emit tick event with current position
            sendBack({ type: 'TICK', currentTime: position, timestamp: performance.now() });

            // Check if we've reached the end
            if (position >= duration) {
                isRunning = false;
                sendBack({ type: 'FINISHED' });
                return;
            }

            // Continue the loop
            animationFrameId = requestAnimationFrame(tick);
        };

        /**
         * Start the timeline
         */
        const start = () => {
            if (isRunning) return;

            isRunning = true;
            startedAt = performance.now();
            accumulatedTime = currentTime;

            animationFrameId = requestAnimationFrame(tick);
        };

        /**
         * Pause the timeline
         */
        const pause = () => {
            if (!isRunning) return;

            // Save current position before stopping
            currentTime = getCurrentPosition();
            accumulatedTime = currentTime;
            isRunning = false;

            if (animationFrameId !== null) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
        };

        /**
         * Resume from pause
         */
        const resume = () => {
            if (isRunning) return;

            isRunning = true;
            startedAt = performance.now();
            // accumulatedTime is already set to the paused position

            animationFrameId = requestAnimationFrame(tick);
        };

        /**
         * Stop the timeline (reset)
         */
        const stop = () => {
            isRunning = false;
            currentTime = 0;
            accumulatedTime = 0;

            if (animationFrameId !== null) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
        };

        /**
         * Seek to specific time
         */
        const seek = (time: number) => {
            const clampedTime = Math.max(0, Math.min(time, duration));
            currentTime = clampedTime;
            accumulatedTime = clampedTime;

            if (isRunning) {
                startedAt = performance.now();
            }

            // Emit immediate tick at new position
            sendBack({ type: 'TICK', currentTime: clampedTime, timestamp: performance.now() });
        };

        /**
         * Change playback speed
         */
        const setSpeed = (newSpeed: number) => {
            if (isRunning) {
                // Preserve current position when changing speed
                accumulatedTime = getCurrentPosition();
                startedAt = performance.now();
            }
            speed = newSpeed;
        };

        // Handle incoming events
        receive((event) => {
            switch (event.type) {
                case 'START':
                    start();
                    break;
                case 'STOP':
                    stop();
                    break;
                case 'PAUSE':
                    pause();
                    break;
                case 'RESUME':
                    resume();
                    break;
                case 'SEEK':
                    seek(event.time);
                    break;
                case 'SET_SPEED':
                    setSpeed(event.speed);
                    break;
            }
        });

        // Cleanup on actor stop
        return () => {
            if (animationFrameId !== null) {
                cancelAnimationFrame(animationFrameId);
            }
        };
    }
);

export type TimelineActorRef = ActorRefFrom<typeof timelineActor>;
