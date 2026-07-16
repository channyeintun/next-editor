# Core XState machine and actor review

Reviewed at commit `457a4a4` on 2026-07-16. The scope was the XState orchestration under
`src/core/src/machine`: `editorMachine`, `timelineMachine`, the audio/camera/screen/mouse callback
actors, their action helpers and event contracts, and the focused machine tests. The installed
XState version is 5.32.2.

The review traced actor creation, event provenance, state exits, delayed callbacks, and resource
cleanup. Replay reducers were inspected where they participate in machine transitions, but their
domain-specific folding logic was not re-reviewed. Existing targeted tests passed before changes
(37 tests across `editorMachine.test.ts` and `screenActor.test.ts`).

Severity meanings: **P1** can leak a live browser resource, corrupt actor ownership, or end a core
workflow incorrectly; **P2** is an important defensive or lifecycle correction. The remediation
described below is implemented with this review.

## P1 — A finishing screen actor can stop a newer screen recording

`editorMachine` spawns screen actors with the fixed child id `screenRecorder`, while deliberately
allowing the actor to outlive the recording state until asynchronous WebM duration repair finishes.
XState's `spawnChild` replaces the entry at the same child id without stopping the previous actor.
If the user unloads the completed lesson and starts another recording before the first repair
finishes, the old actor's `SCREEN_STOPPED` reaches the root handler, where
`stopChild("screenRecorder")` targets the _new_ actor. The new capture is stopped and cleared, and
the old actor becomes unreachable. The old display tracks and audio graph also remain live for the
entire duration-repair wait because normal `onstop` did not clean them up.

### Resolution

- Allocate a monotonically unique child id for each screen capture and include that id in every
  screen event.
- Route `START`, `STOP`, and `stopChild` through the event/context actor id so a late event can only
  affect its originating actor.
- Carry final MIME/offset metadata on `SCREEN_STOPPED`, allowing stale completions to be delivered
  accurately without reading a newer capture's context.
- Release owned tracks and the `AudioContext` as soon as `MediaRecorder.onstop` fires, before the
  asynchronous blob repair.
- Add an overlap regression test that keeps capture A's stop callback pending while capture B starts.

## P1 — The timeline ticker can leave a permanent animation-frame loop

The ticker callback sends `PULSE` and schedules its next frame afterward. At the natural playback
end, handling that `PULSE` synchronously raises `STOP`, exits `running`, and invokes ticker cleanup
before `sendBack` returns. Cleanup therefore cancels the frame that is already executing; the
callback then schedules a new frame after disposal. That frame is no longer reachable by cleanup
and continues scheduling forever, even though XState ignores its events.

### Resolution

Track ticker liveness explicitly, clear the executing frame id, and schedule another frame only if
the callback actor is still active after `sendBack`. A focused test drives a zero-duration timeline
to its natural end and asserts that no animation-frame callback remains queued.

## P1 — Audio completion is indistinguishable from timeline completion

The audio playback actor and timeline actor both send the parent a generic `FINISHED` event. During
lesson playback the timeline is documented and implemented as the master clock, but an early
`HTMLAudioElement.onended` is handled by `playback.playing` as if the timeline completed. The machine
forces `currentTime` to the full recording duration and enters `ended`, truncating any trailing
non-audio frames or tracks. The same generic audio event is also needed for selected-file recording,
which made the handler's intended source implicit.

### Resolution

Namespace all audio child outputs by actor role (`AUDIO_RECORDING_*` and `AUDIO_PLAYBACK_*`). Handle
`AUDIO_PLAYBACK_FINISHED` only in the selected-file recording flow; lesson playback now reaches
`ended` only from the timeline's `FINISHED`. Tests cover both an early audio end during playback and
the selected-file recording completion path.

## P2 — Recorder error and abort paths do not consistently retire their actors

The recording actors handle setup exceptions but did not listen for asynchronous `MediaRecorder`
`error` events. In addition, `CAMERA_ERROR` only cleared context and left the spawned camera child
alive; an external-audio playback error exits `recording` directly while leaving the camera child
recording and `camera.isRecording` set. A later fixed-id spawn can then overwrite that live child.
The audio recorder also lacked the camera actor's guard against a `STOP` received while
`getUserMedia` is pending.

### Resolution

- Report runtime `MediaRecorder` errors from all three recorder actors.
- Stop and remove camera/screen children on their error paths, and reset camera context when an
  external-audio failure aborts the session.
- Retire a camera child when it stops unexpectedly during the main recording.
- Preserve the stopping join for microphone runtime errors so a final `dataavailable`/`stop` event
  can still supply the audio blob, with the existing timeout as fallback.
- Add the missing pending-start stop guard to the audio recorder.

## P2 — Raw control values can violate timeline and media-element invariants

The public `SET_SPEED`, `SET_VOLUME`, and `SEEK` events accept numbers at the type level but only
volume was partially clamped. The machine then forwarded the original, unclamped volume to the
audio actor; values outside 0–1 can throw from `HTMLMediaElement.volume`. Non-finite or non-positive
speeds can stall/reverse the timeline or throw from `playbackRate`, and `NaN` seek/duration values
poison subsequent time calculations.

### Resolution

Use shared finite-value normalizers at the machine boundary, timeline actor, and audio actor. The
editor machine forwards normalized context values to child actors, durations/times stay finite and
non-negative, volume stays in 0–1, and speed stays within the supported 0.5–2 range. Focused tests
exercise the normalization contract, including the value reported to the public seek callback.

## Reviewed without a material finding

`mouseTrackingActor` has symmetric cleanup for document, window, iframe, mutation-observer, and
cross-origin message listeners. The microphone, camera, and screen actors otherwise use callback
actor disposal correctly, and the distinction between invoked state-scoped children (timeline and
mouse tracking) and explicitly spawned cross-state recorder children is appropriate once the
ownership fixes above are applied.

## Validation after remediation

- Targeted TypeScript compilation passed for the changed machine, actor, action, and test files.
- Oxlint passed for the changed TypeScript files.
- All 50 focused tests passed across the editor, audio, camera, screen, timeline, and playback-value
  suites. The regression cases cover each finding above.

A full-repository test/typecheck was intentionally not run because this workspace's low-memory
workflow requires scoped validation.
