import { normalizeAthanLabWav } from "./athanlab/normalizeWav";
import {
  ATHANLAB_MAX_TEXT_CHARS,
  ATHANLAB_RETRY_LATER,
  isOwnCodeOf,
  type AthanLabReconnectCode,
  type AthanLabRetryLaterCode,
} from "./athanlab/protocol";
import { prepareAthanLabText } from "./athanlab/textPrep";
import type { AthanLabVoiceProfile } from "./profiles";
import type { DialogSynthProvider } from "./synthProvider";
import { DROPPED_CONNECTION_ATTEMPTS, postStudioTtsWav, retryDroppedConnection } from "./workerTts";

/**
 * AthanLab synthesis adapter: one same-origin Worker request per dialog. The
 * user's AthanLab API key never reaches the page — the Worker decrypts it per
 * request, fixes every setting but the text and the voice, and submits each
 * dialog under an idempotency key derived from the user and the request body.
 * Asking again for the same dialog therefore re-attaches to the job already
 * bought (within AthanLab's 24 h idempotency window) instead of buying another,
 * which is what makes the retries below safe.
 */

const DEFAULT_RETRY_AFTER_SECONDS = 5;
const MAX_RETRY_AFTER_SECONDS = 60;

/** Appended to every failure a later render can recover from. */
const CONTINUE_HINT =
  " — dialogs already synthesized are kept, so rendering again continues where this stopped.";

/** The message for each Worker code meaning the saved key needs connecting again. */
const RECONNECT_MESSAGES = {
  key_missing: "AthanLab: no AthanLab API key is connected — connect your key, then render again.",
  key_invalid:
    "AthanLab: AthanLab rejected your saved API key — it may have expired or been revoked. Connect a new key, then render again.",
  key_stale:
    "AthanLab: your saved AthanLab API key can no longer be read — connect it again, then render again.",
} as const satisfies Record<AthanLabReconnectCode, string>;

/** A failed AthanLab synthesis; `code` is the Worker's error code when it sent one. */
export class AthanLabSynthesisError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null, options?: ErrorOptions) {
    super(message, options);
    this.name = "AthanLabSynthesisError";
    this.code = code;
  }
}

type SynthesisResponse =
  | { kind: "audio"; bytes: Uint8Array }
  | {
      kind: "retry-later";
      code: AthanLabRetryLaterCode;
      message: string;
      retryAfterSeconds: number;
    };

/** `AthanLab: <detail>`, unless the Worker's message already names AthanLab first. */
function athanLabMessageOf(detail: string): string {
  return /^AthanLab\b/.test(detail) ? detail : `AthanLab: ${detail}`;
}

function failure(detail: string, code: string | null, options?: ErrorOptions): Error {
  const reconnect =
    code !== null && isOwnCodeOf(RECONNECT_MESSAGES, code) ? RECONNECT_MESSAGES[code] : undefined;
  return new AthanLabSynthesisError(
    reconnect ?? `${athanLabMessageOf(detail)}${CONTINUE_HINT}`,
    code,
    options,
  );
}

function retryAfterSecondsOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  return Math.min(Math.max(value, 1), MAX_RETRY_AFTER_SECONDS);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Synthesize one dialog through the same-origin Worker and return it as a
 * dialog take: 16-bit PCM mono WAV at the profile's rate, silence-trimmed.
 * The profile supplies the voice and the cache identity; AthanLab itself is
 * not seedable, so a take is reproduced from the dialog cache, not re-synthesized.
 */
export async function synthesizeAthanLabWav(
  profile: AthanLabVoiceProfile,
  speechText: string,
): Promise<Uint8Array> {
  const text = prepareAthanLabText(speechText);
  if (!text) {
    throw new Error("AthanLab: this dialog has nothing to speak");
  }
  if (text.length > ATHANLAB_MAX_TEXT_CHARS) {
    throw new Error(
      `AthanLab: this dialog is ${text.length} characters long, and AthanLab speaks at most ${ATHANLAB_MAX_TEXT_CHARS} per request — split it with a [[mark:…]]`,
    );
  }
  const body = JSON.stringify({ text, voiceId: profile.voiceId });

  // Two kinds of failure are asked again, both safe because the Worker
  // re-attaches to the same AthanLab job: a dropped connection
  // (retryDroppedConnection, its count starting over at every answer), and
  // the RETRY_LATER answers. Any other Worker error carries its own message
  // and is never retried.
  const retriesUsed = new Map<AthanLabRetryLaterCode, number>();
  for (;;) {
    const response = await retryDroppedConnection(
      () => requestSynthesis(body),
      (error) =>
        failure(
          `the connection failed ${DROPPED_CONNECTION_ATTEMPTS} times (${error.message})`,
          null,
          {
            cause: error,
          },
        ),
    );
    if (response.kind === "audio") {
      return normalizeTake(response.bytes, profile.sampleRate);
    }
    const used = retriesUsed.get(response.code) ?? 0;
    if (used >= ATHANLAB_RETRY_LATER[response.code].retries) {
      throw failure(response.message, response.code);
    }
    retriesUsed.set(response.code, used + 1);
    await wait(response.retryAfterSeconds * 1000);
  }
}

/**
 * The Director's AthanLab provider. It takes no script seed: AthanLab is not
 * seedable, and a take is reproduced from the dialog cache.
 */
export function athanLabSynthProvider(profile: AthanLabVoiceProfile): DialogSynthProvider {
  return {
    sampleRate: profile.sampleRate,
    mimeType: profile.mimeType,
    // A fixed seed keeps a change to the script's seed from re-keying — and
    // so buying again — every AthanLab take.
    seed: 0,
    // Nothing to warm up: each dialog is one Worker request, and a
    // separate request would only spend the user's AthanLab balance.
    preload: async () => undefined,
    synthesize: async (speechText) => ({
      wav: await synthesizeAthanLabWav(profile, speechText),
      hitFrameCap: false,
    }),
    // normalizeAthanLabWav already resampled and trimmed the take.
    prepareTake: (wav) => wav,
  };
}

function normalizeTake(bytes: Uint8Array, sampleRate: number): Uint8Array {
  try {
    return normalizeAthanLabWav(bytes, sampleRate);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw failure(`the returned audio could not be read (${reason})`, null, { cause: error });
  }
}

async function requestSynthesis(body: string): Promise<SynthesisResponse> {
  const result = await postStudioTtsWav("athanlab", body);
  if (result.kind === "not-wav") {
    throw failure("the narration request returned a non-WAV response", null);
  }
  if (result.kind === "error") {
    const { code, detail, status } = result;
    if (
      code !== null &&
      isOwnCodeOf(ATHANLAB_RETRY_LATER, code) &&
      ATHANLAB_RETRY_LATER[code].status === status
    ) {
      return {
        kind: "retry-later",
        code,
        message: detail,
        retryAfterSeconds: retryAfterSecondsOf(result.retryAfterSeconds),
      };
    }
    throw failure(detail, code);
  }
  return result;
}
