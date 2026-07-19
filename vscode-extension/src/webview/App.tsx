import { useEffect, useState } from "react";
import { acquireBridge } from "./bridge/acquireBridge";
import { PROTOCOL_VERSION, type RecordingMetadataPayload } from "./bridge/protocol";

export function App() {
  const [metadata, setMetadata] = useState<RecordingMetadataPayload | null>(null);

  useEffect(() => {
    const bridge = acquireBridge();
    const unsubscribe = bridge.onMessage((message) => {
      if (message.type === "recording.metadata") {
        setMetadata(message.payload);
      }
    });
    bridge.post({ type: "webview.ready", protocolVersion: PROTOCOL_VERSION });
    return unsubscribe;
  }, []);

  return (
    <main className="placeholder">
      <h1>Next Recording Player</h1>
      {metadata ? (
        <p>
          Loaded <code>{metadata.fileName}</code> ({metadata.byteLength} bytes). Playback arrives in
          a later phase.
        </p>
      ) : (
        <p>Waiting for recording metadata…</p>
      )}
    </main>
  );
}
