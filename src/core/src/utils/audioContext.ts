/**
 * The page's one realtime AudioContext. Narration plays through an HTMLAudioElement,
 * so no audio is routed through this context. Its state is how Editor tells whether
 * the page has had the user gesture the autoplay policy asks for before it autoplays
 * a lesson with audio, and play/seek clicks resume it to keep that answer current.
 */

// Gestures that grant user activation. mousedown, touchstart and keydown bubble to
// window; click is taken in the capture phase so a handler that stops propagation
// cannot hide it.
const UNLOCK_GESTURES: ReadonlyArray<readonly [type: string, capture: boolean]> = [
  ["mousedown", false],
  ["touchstart", false],
  ["keydown", false],
  ["click", true],
];

let sharedAudioContext: AudioContext | null = null;
let isListeningForGesture = false;

/**
 * Returns the shared context after asking it to resume. Called from a user gesture,
 * that resumes it directly. Otherwise, until it runs, the next gesture anywhere on
 * the page resumes it; those listeners are installed once, however often this is
 * called, and removed once the context runs.
 */
export function resumeSharedAudioContext(): AudioContext {
  const context = (sharedAudioContext ??= new AudioContext());
  context.resume().catch(() => {});
  if (context.state !== "running" && !isListeningForGesture) {
    resumeOnNextGesture(context);
  }
  return context;
}

function resumeOnNextGesture(context: AudioContext): void {
  isListeningForGesture = true;

  const stopListening = () => {
    isListeningForGesture = false;
    for (const [type, capture] of UNLOCK_GESTURES) {
      window.removeEventListener(type, resume, capture);
    }
  };

  const resume = () => {
    context.resume().then(
      () => {
        if (context.state === "running") stopListening();
      },
      (error: unknown) => {
        console.warn("Failed to resume AudioContext:", error);
      },
    );
  };

  for (const [type, capture] of UNLOCK_GESTURES) {
    window.addEventListener(type, resume, capture);
  }
}
