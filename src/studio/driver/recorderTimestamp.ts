/**
 * Placeholder for the `timestamp` field on events handed to the recorder. The
 * capture appenders always overwrite it with the session-relative time
 * (core/machine/recordingSession.ts), so the value here never survives. It used
 * to be `performance.now()`, which reads like exactly the wall-clock/recording-clock
 * mixup the RecordingSession docblock warns against — and would be one the moment
 * an appender stopped overwriting (QA compares recorded timestamps against planned
 * action times, so a raw reading would fail every preview gate).
 */
export const RECORDER_ASSIGNS_TIMESTAMP = 0;
