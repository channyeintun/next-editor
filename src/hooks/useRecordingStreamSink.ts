import { useEffect } from "react";
import type { RecordingStreamSink } from "../core/src";
import type { EditorActorRef } from "../core/src/useNextEditor";
import { RecordingStreamBridge } from "../storage/recordingStreamSink";

/**
 * Forwards the live SCR3 recording byte stream to an optional {@link RecordingStreamSink}.
 *
 * Subscribes to the editor actor and, while recording, appends newly-captured frames/events
 * to a live SCR3 writer (via {@link RecordingStreamBridge}) and forwards the bytes. Inert when
 * no sink is provided. The machine and actors are untouched — this only observes snapshots.
 */
export function useRecordingStreamSink(
  actorRef: EditorActorRef,
  sink: RecordingStreamSink | undefined,
): void {
  useEffect(() => {
    if (!sink) return;

    let bridge: RecordingStreamBridge | null = null;

    const subscription = actorRef.subscribe((snapshot) => {
      const isRecording = snapshot.value === "recording";
      const session = snapshot.context.session;

      if (isRecording && session) {
        if (!bridge) {
          bridge = new RecordingStreamBridge(sink);
          bridge.start(session);
        }
        bridge.sync(session);
      } else if (bridge) {
        bridge.finish();
        bridge = null;
      }
    });

    return () => {
      subscription.unsubscribe();
      if (bridge) {
        bridge.abort();
        bridge = null;
      }
    };
  }, [actorRef, sink]);
}
