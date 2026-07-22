import { isMobileBrowser } from "./isMobileBrowser";

/**
 * Shared display-capture helpers for opt-in screen recording.
 *
 * Both the manual record button (`MediaControls`) and the studio render console
 * acquire a `getDisplayMedia` stream and hand it to `startRecording({ screenStream })`.
 * The machine owns the stream from there (spawns the screen recorder, muxes tab/mic
 * audio, saves the video locally on finalize) — see `screenActor.ts` and
 * `saveScreenRecordingLocally`. Keeping the acquisition in one place ensures both
 * entry points honour the same support gate and transient-activation constraint.
 */

/**
 * Whether opt-in screen recording can be offered. `getDisplayMedia` is desktop-only (absent on
 * mobile browsers and inside iframes without the `display-capture` permission), and we also gate
 * out mobile explicitly given the landing-demo embed / OOM constraints.
 */
export const isScreenCaptureSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
  !isMobileBrowser();

/**
 * Acquire the display capture stream. MUST be called as the first `await` inside the record-button
 * (or studio "Start render") click handler: `getDisplayMedia` consumes transient user activation,
 * which expires ~5s and would be gone if we waited until the recording machine reached its
 * `recording` state.
 *
 * The extra members below are Chromium-only hints (other browsers ignore unknown options), so they
 * are passed unconditionally via a widened options object.
 */
export const acquireDisplayStream = async (captureTabAudio: boolean): Promise<MediaStream> => {
  const displayOptions = {
    // Native surface size — downscaling screen text destroys readability; let bitrate do the work.
    video: { frameRate: { ideal: 30, max: 30 } },
    // When sharing a tab, Chromium offers "Also share tab audio", which captures app-emitted sound
    // (runtime preview, external-audio narration). Firefox/Safari return no audio track — handled.
    // While voice chat is joined, tab audio is never requested: remote
    // collaborators' voice plays in this tab and must not be recorded.
    audio: captureTabAudio,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "include",
    systemAudio: "exclude",
  };

  // Keep focus on this tab at share start (Chromium 109+); feature-detected and non-fatal.
  const CaptureControllerCtor = (
    window as Window & {
      CaptureController?: new () => { setFocusBehavior?: (behavior: string) => void };
    }
  ).CaptureController;
  if (CaptureControllerCtor) {
    try {
      const controller = new CaptureControllerCtor();
      controller.setFocusBehavior?.("no-focus-change");
      (displayOptions as Record<string, unknown>).controller = controller;
    } catch {
      // Older/partial implementations — proceed without the controller.
    }
  }

  return navigator.mediaDevices.getDisplayMedia(displayOptions as DisplayMediaStreamOptions);
};
