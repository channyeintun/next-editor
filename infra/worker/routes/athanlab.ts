import { Hono } from "hono";
import { requireUser } from "../auth/requireUser";
import type { Env } from "../env";
import { isJsonObject, readJsonWithLimit } from "../httpBody";
import {
  deleteProviderCredential,
  getProviderCredential,
  putProviderCredential,
} from "../../db/providerCredentials";
import { readBreaker, refundKeyCheck, reserveKeyCheck } from "../athanlab/breaker";
import {
  ATHANLAB_KEY_PATTERN,
  ATHANLAB_VOICE_ID_PATTERN,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  READ_TIMEOUT_MS,
  contentLengthOf,
  guardStream,
  mediaTypeOf,
  readJsonBody,
  readJsonGet,
  requestOnce,
  sanitizeAthanLabText,
} from "../athanlab/client";
import {
  MAX_JSON_BYTES,
  MAX_VOICE_LIST_BYTES,
  nonNegativeIntegerOrNull,
  recordOf,
} from "../athanlab/json";
import { keyVaultOf, openApiKey, sealApiKey } from "../athanlab/keyVault";
import {
  TEMPORARILY_UNAVAILABLE,
  authBlocked,
  chargeRateLimit,
  failure,
  keyChecksPaused,
  notConfigured,
} from "../athanlab/responses";
import { PROVIDER, firstContact, outcomeFailure, storedKeyAccess } from "../athanlab/storedKey";
import { readTtsRequest, synthesize } from "../athanlab/synthesis";
import { verifyApiKey, type KeyCheck, type KeyQuote } from "../athanlab/verifyKey";

// Burmese Studio narration with each user's own AthanLab API key.
//
// athanlabRoute is mounted at /api/studio/athanlab (key, voices, voice sample,
// usage) and athanlabTtsRoute at /api/studio/tts/athanlab, beside the VoxCPM2
// route in studio.ts. The browser never sees a stored key again after pasting
// it: every AthanLab call happens here (see athanlab/client.ts), a key
// AthanLab has rejected is never sent again (see invalidateStoredKey), and
// each request's first call with a stored key is made under a per-user lease,
// so concurrent requests carrying a revoked key do not each cost a failed
// authentication (see firstContact; both in athanlab/storedKey.ts). This file
// wires the routes; the key check (athanlab/verifyKey.ts), synthesis
// (athanlab/synthesis.ts) and the JSON answers (athanlab/responses.ts) live
// with the rest of the athanlab/ folder.
export const athanlabRoute = new Hono<{ Bindings: Env }>();
export const athanlabTtsRoute = new Hono<{ Bindings: Env }>();

const MAX_KEY_REQUEST_BYTES = 1024;
const MAX_VOICES = 200;
const MAX_VOICE_NAME_CHARS = 120;
const MAX_VOICE_CATEGORY_CHARS = 60;
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
const MAX_SAMPLE_REDIRECTS = 3;
const UPGRADE_ORIGIN = "https://athanlab.com";
const AUDIO_MEDIA_TYPE_PATTERN = /^audio\/[a-z0-9.+-]{1,64}$/;

const INVALID_FORMAT =
  "That is not an AthanLab API key (it starts with ak_live_ followed by 32 characters)";

// ---------------------------------------------------------------------------
// The key

athanlabRoute.get("/key", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);
  const userId = c.get("user").id;

  const row = await getProviderCredential(c.env.DB, userId, PROVIDER);
  if (!row) return c.json({ connected: false });
  const hint = `…${row.key_hint}`;
  if (row.invalidated_at !== null) {
    return c.json({ connected: false, invalid: true, hint, updatedAt: row.updated_at });
  }
  const apiKey = await openApiKey(vault, userId, row).catch(() => null);
  if (apiKey === null || !ATHANLAB_KEY_PATTERN.test(apiKey)) {
    return c.json({ connected: false, stale: true });
  }
  return c.json({ connected: true, hint, updatedAt: row.updated_at });
});

type KeyRequest = { ok: true; apiKey: string } | { ok: false; status: 400 | 413; error: string };

async function readKeyRequest(request: Request): Promise<KeyRequest> {
  const requestBody = await readJsonWithLimit(request, MAX_KEY_REQUEST_BYTES);
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
  if (!isJsonObject(body) || Object.keys(body).length !== 1 || typeof body.apiKey !== "string") {
    return { ok: false, status: 400, error: "'apiKey' is the only supported field" };
  }
  return { ok: true, apiKey: body.apiKey };
}

athanlabRoute.put("/key", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);
  const userId = c.get("user").id;

  // A plain read first, so a paused or blocked breaker costs nobody budget.
  // It decides nothing under concurrency: the reservation below does.
  const breaker = await readBreaker(c.env.DB);
  if (breaker.blockedUntil > Date.now()) return authBlocked(c, breaker.blockedUntil);
  if (breaker.keyChecksPaused) return keyChecksPaused(c);

  const limited = await chargeRateLimit(c, c.env.ATHANLAB_KEY_RATE_LIMITER, userId);
  if (limited) return limited;

  const request = await readKeyRequest(c.req.raw);
  if (!request.ok) return failure(c, request.status, request.error, "invalid_request");
  // Checked before AthanLab hears of it: a malformed key would still count
  // as a failed authentication against our shared network.
  const apiKey = request.apiKey.trim();
  if (!ATHANLAB_KEY_PATTERN.test(apiKey)) return failure(c, 400, INVALID_FORMAT, "invalid_format");

  // The check is counted as a failed authentication before AthanLab hears of
  // the key, so concurrent checks cannot all pass a breaker that has room for
  // one; it gets the slot back only on a definite answer other than 401.
  const reservation = await reserveKeyCheck(c.env.DB);
  switch (reservation.kind) {
    case "blocked":
      return authBlocked(c, reservation.blockedUntil);
    case "paused":
      return keyChecksPaused(c);
    case "unavailable":
      return failure(c, 503, TEMPORARILY_UNAVAILABLE);
  }
  const check: KeyCheck = { unauthorized: false, uncertain: false };
  let quote: KeyQuote | Response;
  try {
    quote = await verifyApiKey(c, apiKey, check);
  } finally {
    if (!check.unauthorized && !check.uncertain) {
      await refundKeyCheck(c.env.DB, reservation.windowStartedAt);
    }
  }
  if (quote instanceof Response) return quote;

  const sealed = await sealApiKey(vault, userId, apiKey);
  const keyHint = apiKey.slice(-4);
  const now = Date.now();
  await putProviderCredential(c.env.DB, {
    userId,
    provider: PROVIDER,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion,
    keyHint,
    now,
  });
  return c.json({ connected: true, hint: `…${keyHint}`, updatedAt: now, quote });
});

// Removing a key needs no vault: it must work even while AthanLab narration is
// misconfigured, so nobody is left unable to delete what they stored.
athanlabRoute.delete("/key", requireUser, async (c) => {
  await deleteProviderCredential(c.env.DB, c.get("user").id, PROVIDER);
  return c.json({ connected: false });
});

// ---------------------------------------------------------------------------
// Voices, voice samples, usage

interface VoiceSummary {
  id: string;
  name: string;
  category: string;
  source: "athanlab" | "user";
  isDefault: boolean;
}

function voiceListOf(
  payload: unknown,
  apiKey: string,
): { voices: VoiceSummary[]; defaultVoiceId: string | null } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { data, default_voice_id: defaultVoiceId } = payload as Record<string, unknown>;
  if (!Array.isArray(data)) return null;

  const voices: VoiceSummary[] = [];
  for (const entry of data) {
    if (voices.length >= MAX_VOICES) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { id, name, category, source, is_default: isDefault } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !ATHANLAB_VOICE_ID_PATTERN.test(id)) continue;
    if (source !== "athanlab" && source !== "user") continue;
    voices.push({
      id,
      name:
        (typeof name === "string"
          ? sanitizeAthanLabText(name, apiKey, MAX_VOICE_NAME_CHARS)
          : null) ?? id,
      category:
        (typeof category === "string"
          ? sanitizeAthanLabText(category, apiKey, MAX_VOICE_CATEGORY_CHARS)
          : null) ?? "",
      source,
      isDefault: isDefault === true,
    });
  }
  return {
    voices,
    defaultVoiceId:
      typeof defaultVoiceId === "string" && voices.some((voice) => voice.id === defaultVoiceId)
        ? defaultVoiceId
        : null,
  };
}

athanlabRoute.get("/voices", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);
  const key = await storedKeyAccess(c, vault);
  if (key instanceof Response) return key;

  const outcome = await firstContact(c, key, READ_TIMEOUT_MS, () =>
    requestOnce(key.apiKey, readJsonGet("/voices")),
  );
  if (outcome instanceof Response) return outcome;
  if (outcome.kind !== "ok") return outcomeFailure(c, key, outcome, "voices");
  let payload: unknown;
  try {
    payload = await readJsonBody(outcome.response, MAX_VOICE_LIST_BYTES);
  } finally {
    outcome.done();
  }
  const list = voiceListOf(payload, key.apiKey);
  if (!list) {
    return failure(c, 502, "AthanLab returned an unexpected voice list", "unexpected_response");
  }
  return c.json(list);
});

/** An https URL without credentials, or null. */
function safeHttpsUrl(raw: unknown, base?: URL): URL | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  return url.protocol === "https:" && !url.username && !url.password ? url : null;
}

const SAMPLE_UNAVAILABLE = "This AthanLab voice sample could not be loaded";

/**
 * Fetch a voice sample from AthanLab's signed preview URL, with no key, and
 * follow only https redirects. The sample is streamed back from this origin
 * because the app is cross-origin isolated (COEP require-corp): an
 * `<audio src>` pointing at AthanLab's storage would be blocked.
 */
async function fetchSample(url: URL): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_SAMPLE_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        headers: { Accept: "audio/*" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel().catch(() => undefined);
    const next = safeHttpsUrl(response.headers.get("location"), current);
    if (!next) return null;
    current = next;
  }
  return null;
}

athanlabRoute.get("/voices/:id/sample", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);
  const voiceId = c.req.param("id");
  if (!ATHANLAB_VOICE_ID_PATTERN.test(voiceId)) {
    return failure(c, 400, "That is not an AthanLab voice id", "invalid_voice");
  }
  const key = await storedKeyAccess(c, vault);
  if (key instanceof Response) return key;

  const outcome = await firstContact(c, key, READ_TIMEOUT_MS, () =>
    requestOnce(key.apiKey, readJsonGet(`/voices/${encodeURIComponent(voiceId)}/preview`)),
  );
  if (outcome instanceof Response) return outcome;
  if (outcome.kind !== "ok") return outcomeFailure(c, key, outcome, "voice-preview");
  let payload: unknown;
  try {
    payload = await readJsonBody(outcome.response, MAX_JSON_BYTES);
  } finally {
    outcome.done();
  }
  const sampleUrl = safeHttpsUrl(
    typeof payload === "object" && payload !== null ? (payload as { url?: unknown }).url : null,
  );
  if (!sampleUrl) return failure(c, 502, SAMPLE_UNAVAILABLE, "sample_unavailable");

  const sample = await fetchSample(sampleUrl);
  const mediaType = sample ? mediaTypeOf(sample) : "";
  const declared = sample ? contentLengthOf(sample) : null;
  if (
    !sample?.ok ||
    !sample.body ||
    !AUDIO_MEDIA_TYPE_PATTERN.test(mediaType) ||
    (declared !== null && declared > MAX_SAMPLE_BYTES)
  ) {
    await sample?.body?.cancel().catch(() => undefined);
    console.error("AthanLab voice sample was refused", {
      status: sample?.status ?? null,
      contentType: mediaType || null,
    });
    return failure(c, 502, SAMPLE_UNAVAILABLE, "sample_unavailable");
  }
  return new Response(
    guardStream(sample.body, {
      maxBytes: MAX_SAMPLE_BYTES,
      idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
      expectedBytes: declared,
    }),
    {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": mediaType,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
});

function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** AthanLab's upgrade page, and nothing else, may be linked from Studio. */
function upgradeUrlOf(value: unknown): string | null {
  const url = safeHttpsUrl(value);
  return url?.origin === UPGRADE_ORIGIN ? url.toString() : null;
}

athanlabRoute.get("/usage", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);
  const key = await storedKeyAccess(c, vault);
  if (key instanceof Response) return key;

  const outcome = await firstContact(c, key, READ_TIMEOUT_MS, () =>
    requestOnce(key.apiKey, readJsonGet("/usage")),
  );
  if (outcome instanceof Response) return outcome;
  // usage:read is optional, so a key without it simply has no balance to show.
  if (outcome.kind === "rejected" && outcome.error.code === "scope_missing") {
    return c.json({ available: false });
  }
  if (outcome.kind !== "ok") return outcomeFailure(c, key, outcome, "usage");
  let payload: unknown;
  try {
    payload = await readJsonBody(outcome.response, MAX_JSON_BYTES);
  } finally {
    outcome.done();
  }
  if (typeof payload !== "object" || payload === null) {
    return failure(c, 502, "AthanLab returned unexpected usage", "unexpected_response");
  }

  const usage = payload as Record<string, unknown>;
  const monthly = recordOf(usage.monthly);
  const tokens = recordOf(usage.tokens);
  const keyUsage = recordOf(usage.key);
  return c.json({
    available: true,
    spendable: nonNegativeIntegerOrNull(usage.spendable),
    entitled: typeof usage.entitled === "boolean" ? usage.entitled : null,
    upgradeUrl: upgradeUrlOf(usage.upgrade_url),
    monthly: {
      limit: nonNegativeIntegerOrNull(monthly.limit),
      used: nonNegativeIntegerOrNull(monthly.used),
      remaining: nonNegativeIntegerOrNull(monthly.remaining),
      resetsAt: isoDateOrNull(monthly.resets_at),
    },
    tokens: { balance: nonNegativeIntegerOrNull(tokens.balance) },
    key: {
      monthlyCharBudget: nonNegativeIntegerOrNull(keyUsage.monthly_char_budget),
      remaining: nonNegativeIntegerOrNull(keyUsage.remaining),
    },
  });
});

// ---------------------------------------------------------------------------
// Synthesis

athanlabTtsRoute.post("/", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);

  const request = await readTtsRequest(c.req.raw);
  if (!request.ok) return failure(c, request.status, request.error, request.code);

  const key = await storedKeyAccess(c, vault);
  if (key instanceof Response) return key;
  return synthesize(c, key, request.text, request.voiceId);
});
