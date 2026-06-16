import { useEffect } from "react";
import type { RecordingStreamSink } from "../core/src";
import type { EditorActorRef } from "../core/src/useNextEditor";
import { RecordingStreamBridge } from "../storage/recordingStreamSink";

/**
 * Forwards the live SCR3 recording byte stream to an optional {@link RecordingStreamSink}.
 *
 * Subscribes to the editor actor and, while a recording session is active, appends
 * newly-captured frames/events/audio to a live SCR3 writer (via {@link RecordingStreamBridge})
 * and forwards the bytes. The bridge lives exactly as long as the recording session
 * (`context.session`), so it finalizes when the session ends — capturing the final audio chunk.
 * Inert when no sink is provided. The machine and actors are untouched — this only observes
 * snapshots.
 */
export function useRecordingStreamSink(
  actorRef: EditorActorRef,
  sink: RecordingStreamSink | undefined,
): void {
  useEffect(() => {
    if (!sink) return;

    let bridge: RecordingStreamBridge | null = null;

    const subscription = actorRef.subscribe((snapshot) => {
      const session = snapshot.context.session;

      if (session) {
        if (!bridge) {
          bridge = new RecordingStreamBridge(sink);
          const audio = snapshot.context.audio;
          const camera = snapshot.context.camera;
          bridge.start(session, {
            audioType: audio.source ? audio.mimeType || "audio/webm" : undefined,
            audioSource: audio.source ?? undefined,
            audioStartOffsetMs: audio.source ? audio.startOffsetMs : undefined,
            cameraType: camera.source ? camera.mimeType || "video/webm" : undefined,
            cameraSource: camera.source ?? undefined,
            cameraStartOffsetMs: camera.startOffsetMs > 0 ? camera.startOffsetMs : undefined,
          });
        }
        bridge.sync(session);
      } else if (bridge) {
        // Session cleared (recording finalized): flush the tail, footer, and close.
        const finishing = bridge;
        bridge = null;
        void finishing.finish();
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
