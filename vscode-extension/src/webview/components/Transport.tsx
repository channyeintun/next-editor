import type { EngineSnapshot } from "../player/PlaybackEngine";

function formatTime(us: number): string {
  const totalSeconds = Math.floor(us / 1_000_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const RATES = [0.5, 1, 1.5, 2];

export function Transport(props: {
  snapshot: EngineSnapshot;
  onPlayPause: () => void;
  onSeek: (tUs: number) => void;
  onRate: (rate: number) => void;
}) {
  const { snapshot } = props;
  return (
    <div className="transport">
      <button
        type="button"
        className="transport-button"
        onClick={props.onPlayPause}
        aria-label={snapshot.playing ? "Pause" : "Play"}
      >
        {snapshot.playing ? "⏸" : "▶"}
      </button>
      <span className="transport-time">{formatTime(snapshot.playheadUs)}</span>
      <input
        className="transport-seek"
        type="range"
        min={0}
        max={Math.max(1, snapshot.durationUs)}
        value={Math.min(snapshot.playheadUs, snapshot.durationUs)}
        onChange={(event) => props.onSeek(Number(event.target.value))}
        aria-label="Seek"
      />
      <span className="transport-time">{formatTime(snapshot.durationUs)}</span>
      <select
        className="transport-rate"
        value={String(snapshot.rate)}
        onChange={(event) => props.onRate(Number(event.target.value))}
        aria-label="Playback speed"
      >
        {RATES.map((rate) => (
          <option key={rate} value={String(rate)}>
            {rate}×
          </option>
        ))}
      </select>
    </div>
  );
}
