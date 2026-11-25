import { readStoredPreference, writeStoredPreference } from "../../../stores/preferenceStorage";
import { HOWARD_DEFAULT_SERVER_URL, HOWARD_SAMPLING, howardServerUrlOf } from "./protocol";

/**
 * The author's local Howard server (qwentts.cpp's `tts-server`), as the page
 * calls it: which address it is at, which model it loaded, and its two
 * requests — register a cloned voice, speak a text with it. The server sends
 * permissive CORS headers, so the page calls it directly; a browser that asks
 * whether this site may reach apps on this device has to be told yes.
 */

const SERVER_URL_KEY = "next-editor:studio:howard-server-url";
const SERVER_MODEL_KEY = "next-editor:studio:howard-server-model";

/** The address the author's server is at: the stored one while it is still valid, else the default. */
export function howardServerUrl(): string {
  const stored = readStoredPreference(SERVER_URL_KEY);
  const parsed = stored === null ? null : howardServerUrlOf(stored);
  return parsed?.ok ? parsed.url : HOWARD_DEFAULT_SERVER_URL;
}

export function storeHowardServerUrl(url: string): void {
  writeStoredPreference(SERVER_URL_KEY, url === HOWARD_DEFAULT_SERVER_URL ? null : url);
}

/**
 * The model the server last said it runs. Narration is keyed by it, so a
 * lesson narrated earlier renders from the dialog cache while the server is
 * off — and its model out of this computer's memory.
 */
export function rememberedHowardModel(): string | null {
  return readStoredPreference(SERVER_MODEL_KEY);
}

/** What the studio knows of the author's Howard server (HowardPanel reports it). */
export interface HowardServerReport {
  /**
   * The model narration is keyed by: the server's answer, or the last one it
   * gave while it is not answering. Null until a server has answered once.
   */
  modelId: string | null;
  /** The server answered the last check. */
  reachable: boolean;
  /** Why no narration can be made now, or null. */
  reason: string | null;
}

/** Until <HowardPanel> reports, a render with Howard cannot start. */
export const HOWARD_SERVER_NOT_REPORTED: HowardServerReport = {
  modelId: null,
  reachable: false,
  reason: "Checking the Howard server on this computer…",
};

/** The report for a settled check: the model the server named, or why it did not. */
export function howardServerReportOf(
  liveModel: string | null,
  error: string | null,
): HowardServerReport {
  return liveModel !== null
    ? { modelId: liveModel, reachable: true, reason: null }
    : { modelId: rememberedHowardModel(), reachable: false, reason: error };
}

/** A failed call to the Howard server. */
export class HowardServerError extends Error {
  /** "unreachable": nothing answered. "rejected": the server answered with an error. */
  readonly kind: "unreachable" | "rejected";
  /** The server's own message, when it answered with one. */
  readonly detail: string | null;

  constructor(
    message: string,
    kind: HowardServerError["kind"],
    detail: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HowardServerError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** The server's `{"error": {"message": …}}`, or the status when it sent no such body. */
async function errorDetailOf(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
  } | null;
  const message = payload?.error?.message;
  return typeof message === "string" && message
    ? message
    : `the server answered HTTP ${response.status}`;
}

async function callServer(serverUrl: string, path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}${path}`, { ...init, credentials: "omit" });
  } catch (error) {
    // A request nothing answered rejects with a TypeError: the server is not
    // running, or the browser was not allowed to reach this computer.
    if (!(error instanceof TypeError)) throw error;
    throw new HowardServerError(
      `Howard: no server answers at ${serverUrl} — start it on this computer, and allow this site to reach apps on this device if the browser asks`,
      "unreachable",
      null,
      { cause: error },
    );
  }
  if (!response.ok) {
    const detail = await errorDetailOf(response);
    throw new HowardServerError(`Howard: ${detail}`, "rejected", detail);
  }
  return response;
}

function postJson(serverUrl: string, path: string, body: unknown): Promise<Response> {
  return callServer(serverUrl, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The model the server loaded: the talker's GGUF file name, or the name given
 * with `--alias`. The answer is remembered (rememberedHowardModel).
 */
export async function fetchHowardServerModel(
  serverUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await callServer(serverUrl, "/v1/models", { signal });
  const payload = (await response.json().catch(() => null)) as {
    data?: { id?: unknown }[];
  } | null;
  const id = payload?.data?.[0]?.id;
  if (typeof id !== "string" || !id) {
    throw new HowardServerError(
      `Howard: the server at ${serverUrl} did not name its model — is it qwentts.cpp's tts-server?`,
      "rejected",
      null,
    );
  }
  writeStoredPreference(SERVER_MODEL_KEY, id);
  return id;
}

/**
 * Register a cloned voice from a WAV recording, replacing any voice of that
 * name. No transcript is sent, so the server takes the speaker from the
 * recording alone: Howard's transcript-conditioned cloning needs a patched
 * runtime, and speaks unrelated words on the stock one.
 */
export async function registerHowardVoice(
  serverUrl: string,
  name: string,
  wavBase64: string,
): Promise<void> {
  await postJson(serverUrl, "/v1/audio/voices", { name, wav_b64: wavBase64 });
}

export interface HowardSpeechRequest {
  input: string;
  /** A registered voice's name. */
  voice: string;
  seed: number;
  /** The most codec frames the take may run to. */
  maxNewTokens: number;
}

/** Speak `input` in a registered voice: a 24 kHz mono PCM16 WAV. */
export async function requestHowardSpeech(
  serverUrl: string,
  request: HowardSpeechRequest,
): Promise<Uint8Array> {
  const response = await postJson(serverUrl, "/v1/audio/speech", {
    input: request.input,
    voice: request.voice,
    language: HOWARD_SAMPLING.language,
    response_format: "wav",
    seed: request.seed,
    max_new_tokens: request.maxNewTokens,
    temperature: HOWARD_SAMPLING.temperature,
    top_p: HOWARD_SAMPLING.topP,
    subtalker_temperature: HOWARD_SAMPLING.subtalkerTemperature,
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("audio/wav")) {
    throw new HowardServerError("Howard: the server did not answer with a WAV", "rejected", null);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Whether a speech request failed because the server does not hold the voice it named. */
export function isUnknownHowardVoice(error: unknown): boolean {
  return (
    error instanceof HowardServerError &&
    error.kind === "rejected" &&
    error.detail !== null &&
    error.detail.startsWith("unknown voice")
  );
}
