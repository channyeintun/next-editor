import { Hono } from "hono";
import { getCurrentUser } from "../auth/session";
import type { Env } from "../env";
import { readBodyWithLimit } from "../httpBody";
import { isUserFeatureEnabled, STUDIO_BURMESE_VOXCPM2_FEATURE } from "../../db/featureFlags";

// Mounted at /api/studio in worker/index.ts. The capability response controls
// discovery only; POST /tts/voxcpm2 repeats authentication and the D1 check so
// a hidden option can never be invoked by calling the route directly.
export const studioRoute = new Hono<{ Bindings: Env }>();

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000;
const MAX_SEED = 0x7fffffff;
const REFERENCE_SAMPLE_RATE = 24_000;
const MIN_REFERENCE_SECONDS = 5;
const MAX_REFERENCE_SECONDS = 20;
const WAV_HEADER_BYTES = 44;
const MAX_REFERENCE_WAV_BYTES =
  WAV_HEADER_BYTES + REFERENCE_SAMPLE_RATE * MAX_REFERENCE_SECONDS * 2;
const RIFF = 0x46464952;
const WAVE = 0x45564157;
const FMT_ = 0x20746d66;
const DATA = 0x61746164;

interface ModalConfig {
  endpoint: string;
  tokenId: string;
  tokenSecret: string;
}

function modalConfigOf(env: Env): ModalConfig | null {
  const endpoint = env.VOXCPM2_MODAL_ENDPOINT?.trim();
  const tokenId = env.MODAL_PROXY_TOKEN_ID?.trim();
  const tokenSecret = env.MODAL_PROXY_TOKEN_SECRET?.trim();
  if (!endpoint || !tokenId || !tokenSecret) return null;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".modal.run") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  return { endpoint: url.toString(), tokenId, tokenSecret };
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
  const minBytes = WAV_HEADER_BYTES + REFERENCE_SAMPLE_RATE * MIN_REFERENCE_SECONDS * 2;
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
    view.getUint32(24, true) !== REFERENCE_SAMPLE_RATE ||
    view.getUint32(28, true) !== REFERENCE_SAMPLE_RATE * 2 ||
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
  const requestBody = await readBodyWithLimit(request, MAX_REQUEST_BYTES);
  if (requestBody.status === "too-large") {
    return { ok: false, status: 413, error: "request body is too large" };
  }
  if (requestBody.status === "read-error") {
    return { ok: false, status: 400, error: "request body could not be read" };
  }

  let body: unknown;
  try {
    body = JSON.parse(requestBody.text);
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
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

  const {
    text: rawText,
    seed,
    referenceAudioBase64: rawReferenceAudio,
  } = body as Record<string, unknown>;
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text || text.length > MAX_TEXT_CHARS) {
    return {
      ok: false,
      status: 400,
      error: `'text' must contain 1-${MAX_TEXT_CHARS} characters`,
    };
  }
  if (!Number.isSafeInteger(seed) || (seed as number) < 0 || (seed as number) > MAX_SEED) {
    return {
      ok: false,
      status: 400,
      error: `'seed' must be an integer between 0 and ${MAX_SEED}`,
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

studioRoute.get("/capabilities", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);

  const enabled = await hasBurmeseTtsAccess(c.env, user.id);
  return c.json({
    burmeseVoxCpm2: enabled && modalConfigOf(c.env) !== null,
  });
});

studioRoute.post("/tts/voxcpm2", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);

  if (!(await hasBurmeseTtsAccess(c.env, user.id))) {
    return c.json({ error: "Burmese Modal narration is not enabled for this user" }, 403);
  }

  const modal = modalConfigOf(c.env);
  if (!modal) {
    return c.json({ error: "Burmese Modal narration is not configured" }, 503);
  }

  const request = await validateSynthesisRequest(c.req.raw);
  if (!request.ok) {
    return request.status === 413
      ? c.json({ error: request.error }, 413)
      : c.json({ error: request.error }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(modal.endpoint, {
      method: "POST",
      headers: {
        Accept: "audio/wav",
        "Content-Type": "application/json",
        "Modal-Key": modal.tokenId,
        "Modal-Secret": modal.tokenSecret,
      },
      body: JSON.stringify({
        text: request.text,
        seed: request.seed,
        reference_audio_base64: request.referenceAudioBase64,
      }),
    });
  } catch {
    console.error("VoxCPM2 Modal request failed");
    return c.json({ error: "Burmese narration service is unavailable" }, 502);
  }

  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  if (!upstream.ok || !contentType.startsWith("audio/wav") || !upstream.body) {
    console.error("VoxCPM2 Modal returned an unexpected response", {
      status: upstream.status,
      contentType: contentType || null,
    });
    return c.json({ error: "Burmese narration service returned an invalid response" }, 502);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "audio/wav",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
