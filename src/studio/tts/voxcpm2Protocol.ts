/**
 * The VoxCPM2 narration limits the page, the Worker's TTS route
 * (infra/worker/routes/studio.ts), and the Modal synthesizer
 * (integrations/modal/voxcpm2_tts.py, which keeps a Python copy) all enforce.
 * The page and the Worker import them from here, so neither can accept what
 * the other refuses.
 */

/** Seeds are a signed 32-bit int: the largest one any synthesizer accepts. */
export const VOXCPM2_MAX_SEED = 0x7fffffff;

/** The narrator reference is 16-bit mono PCM at this rate. */
export const VOXCPM2_REFERENCE_SAMPLE_RATE = 24_000;

/** Enough reference speech to keep one speaker across dialogs. */
export const VOXCPM2_MIN_REFERENCE_SECONDS = 5;

/** The longest reference the Worker accepts. */
export const VOXCPM2_MAX_REFERENCE_SECONDS = 20;
