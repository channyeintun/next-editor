import { useEffect, useMemo, useSyncExternalStore } from "react";
import { acquireBridge } from "./bridge/acquireBridge";
import { ErrorView } from "./components/ErrorView";
import { RecordedWorkspace } from "./components/RecordedWorkspace";
import { Transport } from "./components/Transport";
import { MonacoRenderer } from "./player/monaco/MonacoRenderer";
import { PlaybackEngine } from "./player/PlaybackEngine";

export function App() {
  const engine = useMemo(() => new PlaybackEngine(acquireBridge(), new MonacoRenderer()), []);
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  useEffect(() => () => engine.dispose(), [engine]);

  if (snapshot.phase === "error") {
    return <ErrorView message={snapshot.error ?? "unknown error"} />;
  }

  if (snapshot.phase === "connecting" || snapshot.phase === "loading") {
    const progress =
      snapshot.totalEvents > 0
        ? ` (${snapshot.loadedEvents.toLocaleString()} / ${snapshot.totalEvents.toLocaleString()} events)`
        : "";
    return (
      <div className="loading-view">
        <h2>Loading recording…</h2>
        <p>
          {snapshot.fileName}
          {progress}
        </p>
      </div>
    );
  }

  return (
    <div className="player">
      {/* structureVersion drives workspace re-render on topology changes */}
      <RecordedWorkspace key={snapshot.structureVersion} engine={engine} />
      <Transport
        snapshot={snapshot}
        onPlayPause={() => (snapshot.playing ? engine.pause() : engine.play())}
        onSeek={(tUs) => void engine.seekTo(tUs)}
        onRate={(rate) => engine.setRate(rate)}
      />
    </div>
  );
}
