/**
 * Singleton AudioContext management for robust browser support (especially Safari)
 */

let sharedAudioContext: AudioContext | null = null;
export let isUnlocked = false;
let audioLifeline: HTMLAudioElement | null = null;

/**
 * Gets the singleton AudioContext instance
 */
export function getAudioContext(): AudioContext {
    if (!sharedAudioContext) {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        sharedAudioContext = new AudioContextClass();
    }
    return sharedAudioContext!;
}

/**
 * Aggressively unlocks the AudioContext on the first user gesture
 */
export function unlockAudioContext(ctx: AudioContext): void {
    // Only set up listeners if we haven't successfully started the lifeline
    if (audioLifeline) return;

    const unlock = () => {
        // 1. WebAudio Unlock
        ctx.resume().then(() => {
            if (ctx.state === 'running') {
                isUnlocked = true;
            }
        }).catch(() => { });

        // 2. HTMLAudio Lifeline (Safari's Magic Keystroke)
        // A looping silent Audio element keeps the hardware clock "hot"
        if (!audioLifeline) {
            try {
                // Base64 for 1 second of silence
                const silentPayload = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';
                audioLifeline = new Audio(silentPayload);
                audioLifeline.loop = true;
                audioLifeline.volume = 0; // Truly silent
                audioLifeline.play().then(() => {
                    removeListeners();
                }).catch(err => {
                    console.error('[AudioContext] Lifeline play failed (waiting for next gesture):', err);
                    audioLifeline = null; // Try again on next click
                });
            } catch (e) {
                console.error('[AudioContext] Lifeline creation failed:', e);
            }
        }
    };

    const removeListeners = () => {
        window.removeEventListener('mousedown', unlock);
        window.removeEventListener('touchstart', unlock);
        window.removeEventListener('keydown', unlock);
        window.removeEventListener('click', unlock, true);
    };

    window.addEventListener('mousedown', unlock);
    window.addEventListener('touchstart', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('click', unlock, true);
}
