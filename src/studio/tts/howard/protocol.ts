/**
 * Howard 0.6B (https://huggingface.co/aungzaythant/Howard-0.6B), a Burmese
 * fine-tune of Qwen3-TTS, as the studio speaks to it. The model runs on the
 * author's own computer: qwentts.cpp's `tts-server` loads Howard's GGUF files
 * and answers OpenAI-style requests on the loopback address
 * (docs/howard-on-device-burmese.md). The page calls that server directly, so
 * the narrator's recording and the script never leave the computer.
 */

export const HOWARD_MODEL = "aungzaythant/Howard-0.6B";

/** Where `tts-server` listens unless it is started with another `--port`. */
export const HOWARD_DEFAULT_SERVER_URL = "http://127.0.0.1:8080";

/**
 * The one command that runs Howard on the author's computer
 * (scripts/howard.sh): the first run downloads the model and builds the
 * server, later runs start it at once.
 */
export const HOWARD_START_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/channyeintun/next-editor/main/scripts/howard.sh | sh";

/**
 * The request settings every dialog is spoken with: the ones the model's own
 * GGUF notes run it with (`--lang auto --temp 0.65 --top-p 0.90 --sub-temp
 * 0.15`). The voice profile carries this object, so a change to any of them
 * re-keys the dialog cache.
 */
export const HOWARD_SAMPLING = {
  language: "auto",
  temperature: 0.65,
  topP: 0.9,
  subtalkerTemperature: 0.15,
} as const;

/** Howard speaks 24 kHz mono. */
export const HOWARD_SAMPLE_RATE = 24_000;

/** One codec frame is 1,920 samples: 12.5 frames a second. */
const SAMPLES_PER_FRAME = 1_920;

/** Qwen3-TTS clones from about three seconds of speech; the model card's own reference is 4.4 s. */
export const HOWARD_MIN_REFERENCE_SECONDS = 3;

/**
 * Whether a stored narrator sample can be Howard's reference: enough speech
 * to take the speaker from, and no longer than `maxSeconds`, the stored-sample
 * limit.
 */
export function isHowardReferenceReady(
  voice: { samples: Float32Array; sampleRate: number },
  maxSeconds: number,
): boolean {
  const seconds = voice.samples.length / voice.sampleRate;
  return seconds >= HOWARD_MIN_REFERENCE_SECONDS && seconds <= maxSeconds;
}

export type HowardServerUrl = { ok: true; url: string } | { ok: false; error: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The server address an author typed, as its origin. Only a plain-HTTP
 * loopback address is accepted: that is what keeps the narrator's recording on
 * this computer, and the only plain-HTTP address a page served over HTTPS may
 * call.
 */
export function howardServerUrlOf(raw: string): HowardServerUrl {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return {
      ok: false,
      error: `"${text}" is not an address — use one like ${HOWARD_DEFAULT_SERVER_URL}`,
    };
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      error: `Howard runs on this computer — use an address like ${HOWARD_DEFAULT_SERVER_URL}`,
    };
  }
  if (url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    return {
      ok: false,
      error: `Use the server's address alone, like ${HOWARD_DEFAULT_SERVER_URL}`,
    };
  }
  return { ok: true, url: url.origin };
}

/** The engine's own ceiling (qwentts.cpp's default `max_new_tokens`): about 164 s of speech. */
const MAX_FRAMES = 2_048;
/** Ten seconds every dialog may take whatever its length: a short line of digits is spoken long. */
const BASE_FRAMES = 125;
/**
 * Burmese narration runs near 14 characters a second, under one frame a
 * character. Three leaves room for a speaker more than three times slower.
 */
const FRAMES_PER_CHAR = 3;

/**
 * The most frames one dialog may run to. The model ends a sentence itself; a
 * take that reaches this did not, and without a bound of its own a short
 * dialog that ran away would cost minutes of this computer's time for 164 s of
 * noise.
 */
export function howardFrameCapOf(speechText: string): number {
  return Math.min(MAX_FRAMES, BASE_FRAMES + FRAMES_PER_CHAR * speechText.trim().length);
}

/** Whether a take of `sampleCount` samples ran to `frameCap` (see howardFrameCapOf). */
export function howardTakeHitFrameCap(sampleCount: number, frameCap: number): boolean {
  return sampleCount >= (frameCap - 1) * SAMPLES_PER_FRAME;
}
