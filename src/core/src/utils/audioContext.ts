/**
 * Singleton AudioContext management for robust browser support
 */

let sharedAudioContext: AudioContext | null = null;
export let isUnlocked = false;

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
    if (isUnlocked) return;

    const unlock = () => {
        ctx.resume().then(() => {
            if (ctx.state === 'running') {
                isUnlocked = true;
                removeListeners();
            }
        }).catch(() => { });
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
