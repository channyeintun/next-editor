/**
 * Version of the audio PocketTtsEngine (engine.ts) makes from a request,
 * folded into every Pocket request hash (ttsRequestHash in profiles.ts) so a
 * change to the engine's samples re-keys Pocket dialogs only. Kept apart from
 * engine.ts so hashing a request does not load onnxruntime-web.
 *
 * v1: the batch-mode port of pocket-tts-web's worker
 * v2: a chunk that runs to the frame cap keeps the audio of its last latents
 */
export const POCKET_ENGINE_VERSION = 2;
