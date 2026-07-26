import { Hono } from "hono";
import { getCurrentUser } from "../auth/session";
import type { Env } from "../env";
import { readBodyWithLimit } from "../httpBody";
import { isUserFeatureEnabled, STUDIO_BURMESE_VOXCPM2_FEATURE } from "../../db/featureFlags";

// Mounted at /api/studio in worker/index.ts. The capability response controls
// discovery only; POST /tts/voxcpm2 repeats authentication and the D1 check so
// a hidden option can never be invoked by calling the route directly.
export const studioRoute = new Hono<{ Bindings: Env }>();

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 2_000;
const MAX_SEED = 0x7fffffff;
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1_000;

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
  | { ok: true; text: string; seed: number }
  | { ok: false; status: 400 | 413; error: string };

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
  if (keys.length !== 2 || keys[0] !== "seed" || keys[1] !== "text") {
    return { ok: false, status: 400, error: "'text' and 'seed' are the only supported fields" };
  }

  const { text: rawText, seed } = body as Record<string, unknown>;
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

  return { ok: true, text, seed: seed as number };
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

  const upstreamSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
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
      body: JSON.stringify({ text: request.text, seed: request.seed }),
      signal: upstreamSignal,
    });
  } catch (error) {
    const timedOut =
      upstreamSignal.aborted || (error instanceof Error && error.name === "TimeoutError");
    console.error("VoxCPM2 Modal request failed", { timedOut });
    return timedOut
      ? c.json({ error: "Burmese narration generation timed out" }, 504)
      : c.json({ error: "Burmese narration service is unavailable" }, 502);
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
