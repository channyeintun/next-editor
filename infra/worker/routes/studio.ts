import { Hono, type Context } from "hono";
import { requireUser } from "../auth/requireUser";
import type { Env } from "../env";
import { isJsonObject, readBodyWithLimit, readJsonWithLimit } from "../httpBody";
import { sanitizeUpstreamText } from "../upstreamText";
import { isUserFeatureEnabled, STUDIO_BURMESE_VOXCPM2_FEATURE } from "../../db/featureFlags";
import { keyVaultOf } from "../athanlab/keyVault";
import {
  VOXCPM2_MAX_REFERENCE_SECONDS,
  VOXCPM2_MAX_SEED,
  VOXCPM2_MIN_REFERENCE_SECONDS,
  VOXCPM2_REFERENCE_SAMPLE_RATE,
} from "../../../src/studio/tts/voxcpm2Protocol";

// Mounted at /api/studio in worker/index.ts. The capability response controls
// discovery only; POST /tts/voxcpm2 repeats authentication and the D1 check so
// a hidden option can never be invoked by calling the route directly. AthanLab
// narration (routes/athanlab.ts) needs no flag: every signed-in user may bring
// their own key, so its capability only says whether the server can store one.
export const studioRoute = new Hono<{ Bindings: Env }>();

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000;
const WAV_HEADER_BYTES = 44;
const MAX_REFERENCE_WAV_BYTES =
  WAV_HEADER_BYTES + VOXCPM2_REFERENCE_SAMPLE_RATE * VOXCPM2_MAX_REFERENCE_SECONDS * 2;
const RIFF = 0x46464952;
const WAVE = 0x45564157;
const FMT_ = 0x20746d66;
const DATA = 0x61746164;
// An upstream error body is read only to quote its message; FastAPI's
// {"detail": "..."} errors are far below this.
const MAX_UPSTREAM_ERROR_BYTES = 4 * 1024;
const MAX_UPSTREAM_DETAIL_CHARS = 200;
// Anything shaped like a Modal proxy-auth token id or secret (wk-…, ws-…).
const MODAL_TOKEN_PATTERN = /\b(?:wk|ws)-[A-Za-z0-9]{10,}\b/g;
// Modal FunctionCall ids, e.g. "fc-01K…" — the only job id ever put in a URL.
const MODAL_CALL_ID_PATTERN = /^fc-[0-9A-Za-z]{1,64}$/;

// A synthesis is a Modal job that the Worker submits and then polls, never one
// long request: a cold L4 start spends about a minute before its first step,
// plus any wait for a free GPU, and Cloudflare ends a subrequest that has not
// answered within its proxy read timeout (125 s) with a 524. Modal holds each
// poll open for at most 20 s, so every subrequest stays far inside that.
const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 60_000;
// Only paces polls that Modal answers early; a normal poll already waited 20 s.
const MIN_POLL_INTERVAL_MS = 5_000;
// The browser request stays open this long at most: a cold start (≈66 s) plus
// the longest dialog seen (≈49 s) leaves about 160 s for GPU queueing.
const SYNTHESIS_DEADLINE_MS = 280_000;
// Keeps submit + polls + cancel under the 50-subrequest Workers Free limit.
const MAX_POLLS = 45;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const CANCEL_TIMEOUT_MS = 5_000;
// Statuses that say the job could not be read, not that it failed: a hiccup
// between the Worker and Modal, or the jobs app's 503 when it briefly cannot
// reach Modal's API. The same job is polled again.
const TRANSIENT_POLL_STATUSES = new Set([502, 503, 504, 524]);

interface ModalConfig {
  /** Base URL of the Modal jobs app (`/jobs`, `/jobs/{id}`). */
  jobsUrl: string;
  tokenId: string;
  tokenSecret: string;
}

function modalConfigOf(env: Env): ModalConfig | null {
  const jobsUrl = env.VOXCPM2_MODAL_JOBS_URL?.trim();
  const tokenId = env.MODAL_PROXY_TOKEN_ID?.trim();
  const tokenSecret = env.MODAL_PROXY_TOKEN_SECRET?.trim();
  if (!jobsUrl || !tokenId || !tokenSecret) return null;

  let url: URL;
  try {
    url = new URL(jobsUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".modal.run") ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  return { jobsUrl: url.toString(), tokenId, tokenSecret };
}

function modalAuthHeaders(modal: ModalConfig): Record<string, string> {
  return { "Modal-Key": modal.tokenId, "Modal-Secret": modal.tokenSecret };
}

function jobUrl(modal: ModalConfig, callId: string): URL {
  return new URL(`/jobs/${callId}`, modal.jobsUrl);
}

/**
 * Make Modal text safe to hand back to the browser (upstreamText.ts): the
 * configured credentials and endpoint host are redacted wherever they appear,
 * anything shaped like a Modal token too, control characters are flattened,
 * and the result is length-bounded.
 */
function sanitizeModalText(text: string, modal: ModalConfig): string | null {
  return sanitizeUpstreamText(text, {
    secrets: [modal.tokenSecret, modal.tokenId, new URL(modal.jobsUrl).hostname],
    secretPattern: MODAL_TOKEN_PATTERN,
    maxChars: MAX_UPSTREAM_DETAIL_CHARS,
  });
}

/**
 * The message from a failed Modal response, when it carries one: FastAPI's
 * `{"detail": "..."}` (what the endpoint raises for rejected input) or a short
 * plain-text body. HTML error pages and oversized bodies yield nothing; no
 * upstream header is ever read into the message.
 */
async function upstreamErrorDetail(upstream: Response, modal: ModalConfig): Promise<string | null> {
  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  const isJson = contentType.startsWith("application/json");
  if (!isJson && !contentType.startsWith("text/plain")) {
    await upstream.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = await readBodyWithLimit(upstream, MAX_UPSTREAM_ERROR_BYTES);
  if (body.status !== "ok") {
    // A declared Content-Length over the limit is refused before any read, so
    // release that untouched body too.
    await upstream.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!isJson) return sanitizeModalText(body.text, modal);

  let payload: unknown;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const { detail, error } = payload as Record<string, unknown>;
  const message = typeof detail === "string" ? detail : typeof error === "string" ? error : null;
  return message === null ? null : sanitizeModalText(message, modal);
}

async function hasBurmeseTtsAccess(env: Env, userId: string): Promise<boolean> {
  return isUserFeatureEnabled(env.DB, userId, STUDIO_BURMESE_VOXCPM2_FEATURE);
}

type SynthesisRequestValidation =
  | { ok: true; text: string; seed: number; referenceAudioBase64: string }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Validate the reference clip without ever materializing it as bytes. The clip
 * is forwarded to Modal as the same base64 string that arrived, so the only
 * things worth checking are its encoding, its decoded length, and its 44-byte
 * WAV header — and every one of those is available without decoding the body.
 *
 * This runs on a ~1.28 MB payload, so the shape of the check is a CPU budget,
 * not a style question: decoding the whole clip through
 * `Uint8Array.from(binary, …)` cost ~44 ms of Worker CPU per request on a 20s
 * reference and tripped the CPU limit. `atob` validates the alphabet and
 * `btoa` round-trip validates canonical form, both in native code, for ~0.4 ms.
 */
function validateReferenceAudioBase64(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length % 4 !== 0 ||
    raw.length > Math.ceil(MAX_REFERENCE_WAV_BYTES / 3) * 4
  ) {
    return { ok: false, error: "reference audio must be a 5–20s mono 24 kHz PCM16 WAV" };
  }

  // `atob` throws on characters outside the base64 alphabet, and its forgiving
  // decode tolerates whitespace and non-canonical padding that the re-encode
  // then rejects — so what we validate is byte-for-byte what Modal decodes.
  let binary: string;
  try {
    binary = atob(raw);
  } catch {
    return { ok: false, error: "reference audio is not valid base64" };
  }
  if (btoa(binary) !== raw) {
    return { ok: false, error: "reference audio is not valid base64" };
  }

  const byteLength = binary.length;
  const minBytes =
    WAV_HEADER_BYTES + VOXCPM2_REFERENCE_SAMPLE_RATE * VOXCPM2_MIN_REFERENCE_SECONDS * 2;
  if (byteLength < minBytes || byteLength > MAX_REFERENCE_WAV_BYTES) {
    return { ok: false, error: "reference audio must contain 5–20 seconds of speech" };
  }

  const header = new Uint8Array(WAV_HEADER_BYTES);
  for (let index = 0; index < WAV_HEADER_BYTES; index++) {
    header[index] = binary.charCodeAt(index);
  }
  const view = new DataView(header.buffer);
  const dataBytes = view.getUint32(40, true);
  if (
    view.getUint32(0, true) !== RIFF ||
    view.getUint32(4, true) !== byteLength - 8 ||
    view.getUint32(8, true) !== WAVE ||
    view.getUint32(12, true) !== FMT_ ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== VOXCPM2_REFERENCE_SAMPLE_RATE ||
    view.getUint32(28, true) !== VOXCPM2_REFERENCE_SAMPLE_RATE * 2 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    view.getUint32(36, true) !== DATA ||
    dataBytes !== byteLength - WAV_HEADER_BYTES
  ) {
    return { ok: false, error: "reference audio must be a mono 24 kHz PCM16 WAV" };
  }
  return { ok: true, value: raw };
}

async function validateSynthesisRequest(request: Request): Promise<SynthesisRequestValidation> {
  const requestBody = await readJsonWithLimit(request, MAX_REQUEST_BYTES);
  if (requestBody.status === "too-large") {
    return { ok: false, status: 413, error: "request body is too large" };
  }
  if (requestBody.status === "read-error") {
    return { ok: false, status: 400, error: "request body could not be read" };
  }
  if (requestBody.status === "invalid-json") {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }

  const body = requestBody.value;
  if (!isJsonObject(body)) {
    return { ok: false, status: 400, error: "JSON body must be an object" };
  }

  const keys = Object.keys(body).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "referenceAudioBase64" ||
    keys[1] !== "seed" ||
    keys[2] !== "text"
  ) {
    return {
      ok: false,
      status: 400,
      error: "'text', 'seed', and 'referenceAudioBase64' are the only supported fields",
    };
  }

  const { text: rawText, seed, referenceAudioBase64: rawReferenceAudio } = body;
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text || text.length > MAX_TEXT_CHARS) {
    return {
      ok: false,
      status: 400,
      error: `'text' must contain 1-${MAX_TEXT_CHARS} characters`,
    };
  }
  if (!Number.isSafeInteger(seed) || (seed as number) < 0 || (seed as number) > VOXCPM2_MAX_SEED) {
    return {
      ok: false,
      status: 400,
      error: `'seed' must be an integer between 0 and ${VOXCPM2_MAX_SEED}`,
    };
  }

  const referenceAudio = validateReferenceAudioBase64(rawReferenceAudio);
  if (!referenceAudio.ok) {
    return { ok: false, status: 400, error: referenceAudio.error };
  }

  return {
    ok: true,
    text,
    seed: seed as number,
    referenceAudioBase64: referenceAudio.value,
  };
}

studioRoute.get("/capabilities", requireUser, async (c) => {
  const user = c.get("user");

  const enabled = await hasBurmeseTtsAccess(c.env, user.id);
  return c.json({
    burmeseVoxCpm2: enabled && modalConfigOf(c.env) !== null,
    athanlab: keyVaultOf(c.env) !== null,
  });
});

studioRoute.post("/tts/voxcpm2", requireUser, async (c) => {
  const user = c.get("user");

  if (!(await hasBurmeseTtsAccess(c.env, user.id))) {
    return c.json({ error: "Burmese Modal narration is not enabled for this user" }, 403);
  }

  const modal = modalConfigOf(c.env);
  if (!modal) {
    return c.json({ error: "Burmese Modal narration is not configured" }, 503);
  }

  const request = await validateSynthesisRequest(c.req.raw);
  if (!request.ok) {
    return c.json({ error: request.error }, request.status);
  }

  let submitted: Response;
  try {
    submitted = await fetch(new URL("/jobs", modal.jobsUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...modalAuthHeaders(modal),
      },
      body: JSON.stringify({
        text: request.text,
        seed: request.seed,
        reference_audio_base64: request.referenceAudioBase64,
      }),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  } catch {
    console.error("VoxCPM2 Modal job submission failed");
    return c.json({ error: "Burmese narration service is unavailable" }, 502);
  }
  if (!submitted.ok) return upstreamFailure(c, submitted, modal, "submit");

  const callId = await callIdOf(submitted);
  if (!callId) {
    console.error("VoxCPM2 Modal returned no synthesis job");
    return c.json({ error: "Burmese narration service returned no synthesis job" }, 502);
  }

  const result = await pollJob(c, modal, callId);
  if (!result.ok) {
    // Whatever ended the wait, the job may still hold the single GPU container;
    // its result is not wanted any more, and a cancel that fails changes nothing.
    await fetch(jobUrl(modal, callId), {
      method: "DELETE",
      headers: modalAuthHeaders(modal),
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  }
  return result;
});

/** Poll a submitted job until its audio arrives or the wait has to end. */
async function pollJob(c: Context, modal: ModalConfig, callId: string): Promise<Response> {
  const startedAt = Date.now();
  const deadline = startedAt + SYNTHESIS_DEADLINE_MS;
  let consecutiveFailures = 0;
  for (let polls = 1; polls <= MAX_POLLS && Date.now() < deadline; polls++) {
    const pollStartedAt = Date.now();
    let upstream: Response | null = null;
    try {
      upstream = await fetch(jobUrl(modal, callId), {
        method: "GET",
        headers: { Accept: "audio/wav", ...modalAuthHeaders(modal) },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
    } catch {
      upstream = null;
    }

    // 202 counts as ok to fetch, so it has to be told apart first.
    const pending = upstream?.status === 202;
    if (pending || !upstream || TRANSIENT_POLL_STATUSES.has(upstream.status)) {
      await upstream?.body?.cancel().catch(() => undefined);
      if (pending) {
        consecutiveFailures = 0;
      } else if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        console.error("VoxCPM2 Modal job polling failed", {
          status: upstream?.status ?? null,
          polls,
          elapsedMs: Date.now() - startedAt,
        });
        return c.json(
          {
            error: upstream
              ? `Burmese narration service failed with HTTP ${upstream.status}`
              : "Burmese narration service is unavailable",
          },
          502,
        );
      }
      const wait = Math.min(
        Math.max(0, MIN_POLL_INTERVAL_MS - (Date.now() - pollStartedAt)),
        Math.max(0, deadline - Date.now()),
      );
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }

    if (!upstream.ok) return upstreamFailure(c, upstream, modal, "poll");
    return wavResponse(c, upstream, modal);
  }

  console.error("VoxCPM2 Modal job did not finish in time", {
    elapsedMs: Date.now() - startedAt,
  });
  return c.json(
    {
      error: `Burmese narration did not finish within ${SYNTHESIS_DEADLINE_MS / 1000} s, so the job was cancelled; start the render again`,
    },
    504,
  );
}

/** The job id from a submit response, or null when it carries none. */
async function callIdOf(submitted: Response): Promise<string | null> {
  const body = await readBodyWithLimit(submitted, MAX_UPSTREAM_ERROR_BYTES);
  if (body.status !== "ok") {
    await submitted.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    const { call_id: callId } = JSON.parse(body.text) as { call_id?: unknown };
    return typeof callId === "string" && MODAL_CALL_ID_PATTERN.test(callId) ? callId : null;
  } catch {
    return null;
  }
}

// Every upstream failure stays a 502 (the client only distinguishes ok from
// not ok); the message says what went wrong so a failed render is actionable.
async function upstreamFailure(
  c: Context,
  upstream: Response,
  modal: ModalConfig,
  phase: "submit" | "poll",
) {
  const detail = await upstreamErrorDetail(upstream, modal);
  console.error("VoxCPM2 Modal request was rejected", { phase, status: upstream.status, detail });
  return c.json(
    {
      error: `Burmese narration service failed with HTTP ${upstream.status}${detail ? `: ${detail}` : ""}`,
    },
    502,
  );
}

async function wavResponse(c: Context, upstream: Response, modal: ModalConfig) {
  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("audio/wav") || !upstream.body) {
    await upstream.body?.cancel().catch(() => undefined);
    console.error("VoxCPM2 Modal returned an unexpected response", {
      status: upstream.status,
      contentType: contentType || null,
    });
    const received = contentType
      ? `"${sanitizeModalText(contentType, modal) ?? "unknown"}"`
      : "no content type";
    return c.json(
      {
        error: upstream.body
          ? `Burmese narration service returned ${received} instead of audio/wav`
          : "Burmese narration service returned an empty response",
      },
      502,
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "audio/wav",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
