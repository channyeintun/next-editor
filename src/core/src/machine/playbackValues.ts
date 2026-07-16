export const DEFAULT_PLAYBACK_SPEED = 1;
export const DEFAULT_PLAYBACK_VOLUME = 1;
export const MIN_PLAYBACK_SPEED = 0.5;
export const MAX_PLAYBACK_SPEED = 2;

export const normalizePlaybackSpeed = (
  value: number,
  fallback = DEFAULT_PLAYBACK_SPEED,
): number => {
  const safeFallback = Number.isFinite(fallback)
    ? Math.max(MIN_PLAYBACK_SPEED, Math.min(MAX_PLAYBACK_SPEED, fallback))
    : DEFAULT_PLAYBACK_SPEED;
  return Number.isFinite(value)
    ? Math.max(MIN_PLAYBACK_SPEED, Math.min(MAX_PLAYBACK_SPEED, value))
    : safeFallback;
};

export const normalizePlaybackVolume = (
  value: number,
  fallback = DEFAULT_PLAYBACK_VOLUME,
): number => {
  const safeFallback = Number.isFinite(fallback)
    ? Math.max(0, Math.min(1, fallback))
    : DEFAULT_PLAYBACK_VOLUME;
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : safeFallback;
};

export const normalizeTimelineDuration = (value: number, fallback = 0): number => {
  const safeFallback = Number.isFinite(fallback) && fallback >= 0 ? fallback : 0;
  return Number.isFinite(value) && value >= 0 ? value : safeFallback;
};

export const normalizeNonNegativeTime = (value: number, fallback = 0): number => {
  const safeFallback = Number.isFinite(fallback) && fallback >= 0 ? fallback : 0;
  return Number.isFinite(value) ? Math.max(0, value) : safeFallback;
};

export const normalizeTimelineTime = (value: number, duration: number, fallback = 0): number => {
  const safeDuration = normalizeTimelineDuration(duration);
  const safeFallback = Number.isFinite(fallback)
    ? Math.max(0, Math.min(fallback, safeDuration))
    : 0;
  return Number.isFinite(value) ? Math.max(0, Math.min(value, safeDuration)) : safeFallback;
};
