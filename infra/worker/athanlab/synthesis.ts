import { sha256Hex } from "../../../src/shared/sha256Hex";
import { isJsonObject, readJsonWithLimit } from "../httpBody";
import {
  ATHANLAB_MAX_TEXT_CHARS,
  type AthanLabErrorCode,
} from "../../../src/studio/tts/athanlab/protocol";
import {
  ATHANLAB_VOICE_ID_PATTERN,
  DOWNLOAD_HEADERS_TIMEOUT_MS,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  POLL_TIMEOUT_MS,
  SUBMIT_TIMEOUT_MS,
  contentLengthOf,
  describeAthanLabError,
  guardStream,
  mediaTypeOf,
  requestJsonWithRetries,
  requestWithRetries,
  retryAfterSecondsOf,
  sanitizeAthanLabText,
  sleep,
  speechJobOf,
  type AthanLabError,
  type PhaseOutcome,
  type RetryContext,
  type SpeechJob,
} from "./client";
import { MAX_JSON_BYTES } from "./json";
import { failure, logUpstream, stillProcessing, type ErrorCode } from "./responses";
import { firstContact, outcomeFailure, type SignedInContext, type StoredKey } from "./storedKey";

// Speaking one dialog (POST /api/studio/tts/athanlab): submit the job, poll it
// within this request's deadline and subrequest budget, and stream its WAV
// back.

const MAX_TTS_REQUEST_BYTES = 64 * 1024;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const WAV_MEDIA_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);

// One browser request drives one dialog's synthesis for at most this long,
// then hands back `still_processing` with the job left running: AthanLab may
// queue a job for up to 45 minutes, and the browser's next POST re-attaches
// to the same job through its idempotency key.
const SYNTHESIS_DEADLINE_MS = 240_000;
// Submits, polls and downloads together stay under the 50-subrequest Workers
// Free limit, and the last three are kept for downloading finished audio.
const SUBREQUEST_BUDGET = 45;
const DOWNLOAD_RESERVE = 3;
// Fresh (charged) jobs one browser request may start; idempotent replays of
// earlier jobs are free and do not count.
const MAX_FRESH_JOBS = 3;
// Attempt keys run base, base.r1 … base.r7, so one user's dialog starts at
// most eight jobs within AthanLab's 24-hour idempotency window (and a failed
// job is refunded in full).
const MAX_RETRY_KEY = 7;
const DEFAULT_FIRST_POLL_MS = 2_000;
const MIN_FIRST_POLL_MS = 1_000;

type TtsRequest =
  | { ok: true; text: string; voiceId: string }
  | { ok: false; status: 400 | 413; error: string; code: AthanLabErrorCode };

export async function readTtsRequest(request: Request): Promise<TtsRequest> {
  const requestBody = await readJsonWithLimit(request, MAX_TTS_REQUEST_BYTES);
  if (requestBody.status === "too-large") {
    return { ok: false, status: 413, error: "request body is too large", code: "invalid_request" };
  }
  if (requestBody.status === "read-error") {
    return {
      ok: false,
      status: 400,
      error: "request body could not be read",
      code: "invalid_request",
    };
  }
  if (requestBody.status === "invalid-json") {
    return { ok: false, status: 400, error: "invalid JSON body", code: "invalid_request" };
  }
  const body = requestBody.value;
  const keys = isJsonObject(body) ? Object.keys(body).sort() : [];
  if (!isJsonObject(body) || keys.length !== 2 || keys[0] !== "text" || keys[1] !== "voiceId") {
    return {
      ok: false,
      status: 400,
      error: "'text' and 'voiceId' are the only supported fields",
      code: "invalid_request",
    };
  }
  const { text: rawText, voiceId } = body;
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text || text.length > ATHANLAB_MAX_TEXT_CHARS) {
    return {
      ok: false,
      status: 400,
      error: `'text' must contain 1-${ATHANLAB_MAX_TEXT_CHARS} characters`,
      code: "invalid_text",
    };
  }
  if (typeof voiceId !== "string" || !ATHANLAB_VOICE_ID_PATTERN.test(voiceId)) {
    return {
      ok: false,
      status: 400,
      error: "'voiceId' is not an AthanLab voice id",
      code: "invalid_voice",
    };
  }
  return { ok: true, text, voiceId };
}

/** How long to wait before the next poll, by how long the job has been followed. */
function pollIntervalMs(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 3_000;
  if (elapsedMs < 90_000) return 5_000;
  return 10_000;
}

type PollResult =
  | { kind: "finished"; job: SpeechJob }
  | { kind: "still_processing" }
  | { kind: "unexpected" }
  | Exclude<PhaseOutcome, { kind: "ok" | "out_of_budget" }>;

/**
 * Poll a processing job until it finishes, or until the deadline or the
 * subrequest budget (less the download reserve) would run out — then the job
 * is left running for the browser's next request to re-attach to.
 */
async function pollJob(
  context: RetryContext,
  jobId: string,
  firstWaitMs: number,
): Promise<PollResult> {
  const startedAt = Date.now();
  let waitMs = firstWaitMs;
  for (;;) {
    if (
      Date.now() + waitMs >= context.deadline ||
      context.budget.used + DOWNLOAD_RESERVE >= context.budget.limit
    ) {
      return { kind: "still_processing" };
    }
    await sleep(waitMs);

    const outcome = await requestJsonWithRetries(
      context,
      {
        method: "GET",
        path: `/speech/${jobId}`,
        accept: "application/json",
        timeoutMs: POLL_TIMEOUT_MS,
      },
      DOWNLOAD_RESERVE,
      MAX_JSON_BYTES,
    );
    if (outcome.kind === "out_of_budget") return { kind: "still_processing" };
    if (outcome.kind !== "ok") return outcome;
    const job = speechJobOf(outcome.payload, context.apiKey);
    if (!job || job.id !== jobId) return { kind: "unexpected" };
    if (job.status !== "processing") return { kind: "finished", job };
    waitMs = pollIntervalMs(Date.now() - startedAt);
  }
}

type DownloadResult =
  | { kind: "audio"; response: Response }
  | { kind: "expired"; error: AthanLabError }
  | { kind: "failed"; response: Response };

/**
 * Download a finished job's WAV and stream it straight to the browser. Only
 * the response headers are under a timeout; the body then passes a guard that
 * errors on a 30 s stall, past 64 MiB, or short of its Content-Length, so a
 * truncated file never reaches the browser as a complete one.
 */
async function downloadAudio(
  c: SignedInContext,
  key: StoredKey,
  context: RetryContext,
  jobId: string,
): Promise<DownloadResult> {
  const outcome = await requestWithRetries(context, {
    method: "GET",
    path: `/speech/${jobId}/audio?format=wav`,
    accept: "audio/wav",
    timeoutMs: DOWNLOAD_HEADERS_TIMEOUT_MS,
  });
  if (outcome.kind === "rejected" && outcome.error.code === "audio_expired") {
    logUpstream("download", outcome.error);
    return { kind: "expired", error: outcome.error };
  }
  if (outcome.kind !== "ok") {
    return { kind: "failed", response: await outcomeFailure(c, key, outcome, "download") };
  }
  outcome.done();

  const { response } = outcome;
  const mediaType = mediaTypeOf(response);
  const declared = contentLengthOf(response);
  if (
    !WAV_MEDIA_TYPES.has(mediaType) ||
    !response.body ||
    declared === 0 ||
    (declared !== null && declared > MAX_AUDIO_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    console.error("AthanLab returned unexpected audio", {
      status: response.status,
      contentType: mediaType || null,
      contentLength: declared,
    });
    const received = mediaType
      ? `"${sanitizeAthanLabText(mediaType, key.apiKey, 80) ?? "unknown"}"`
      : "no content type";
    return {
      kind: "failed",
      response: failure(
        c,
        502,
        WAV_MEDIA_TYPES.has(mediaType)
          ? "AthanLab returned an empty or oversized audio file"
          : `AthanLab returned ${received} instead of WAV audio`,
        "unexpected_response",
      ),
    };
  }

  return {
    kind: "audio",
    response: new Response(
      guardStream(response.body, {
        maxBytes: MAX_AUDIO_BYTES,
        idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
        expectedBytes: declared,
      }),
      {
        status: 200,
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": "audio/wav",
          "X-Content-Type-Options": "nosniff",
        },
      },
    ),
  };
}

/**
 * Speak one dialog. The request body AthanLab receives is serialized once,
 * and its idempotency key is derived from exactly that string, so the same
 * dialog for the same user always re-attaches to the same job: a retried
 * browser request, or one after `still_processing`, is never charged again.
 *
 * A job is never cancelled. It ends one of four ways: its audio is streamed
 * back; it failed retryably, was cancelled elsewhere, or its audio expired,
 * and the next attempt key starts a new job (at most three fresh jobs per
 * request, and never past base.r7); it failed for good (502); or time or
 * subrequests ran out while it was processing (503 still_processing).
 */
export async function synthesize(
  c: SignedInContext,
  key: StoredKey,
  text: string,
  voiceId: string,
): Promise<Response> {
  const body = JSON.stringify({
    text,
    voice_id: voiceId,
    output_format: "wav",
    number_mode: "smart",
    metadata: { source: "next-editor-studio" },
  });
  const idempotencyBase = `ne1:${await sha256Hex(`${c.get("user").id}\n${body}`)}`;
  const context: RetryContext = {
    apiKey: key.apiKey,
    deadline: Date.now() + SYNTHESIS_DEADLINE_MS,
    budget: { used: 0, limit: SUBREQUEST_BUDGET },
  };

  let freshJobs = 0;
  let advancedOnConflict = false;
  let lastFailure: { message: string; code: ErrorCode } = {
    message: "AthanLab did not finish this dialog",
    code: "generation_failed",
  };
  for (let attempt = 0; attempt <= MAX_RETRY_KEY; attempt++) {
    const submit = () =>
      requestJsonWithRetries(
        context,
        {
          method: "POST",
          path: "/speech",
          accept: "application/json",
          body,
          idempotencyKey: attempt === 0 ? idempotencyBase : `${idempotencyBase}.r${attempt}`,
          timeoutMs: SUBMIT_TIMEOUT_MS,
        },
        DOWNLOAD_RESERVE,
        MAX_JSON_BYTES,
      );
    // The first submit, transient retries included, is this request's first
    // contact; later submits, polls and downloads follow an answer.
    const submitted =
      attempt === 0 ? await firstContact(c, key, SUBMIT_TIMEOUT_MS, submit) : await submit();
    if (submitted instanceof Response) return submitted;
    if (submitted.kind !== "ok") {
      if (
        submitted.kind === "rejected" &&
        submitted.error.code === "idempotency_conflict" &&
        !advancedOnConflict
      ) {
        // Same key, different body: only a change to how the body is built
        // can cause this. Move past the key once rather than fail the dialog.
        advancedOnConflict = true;
        console.error("AthanLab idempotency conflict", {
          requestId: submitted.error.requestId,
          jobId: submitted.error.details.jobId ?? null,
        });
        continue;
      }
      return outcomeFailure(c, key, submitted, "submit");
    }

    const replayed = submitted.response.headers.get("idempotent-replayed") === "true";
    const retryAfterSeconds = retryAfterSecondsOf(submitted.response);
    const accepted = speechJobOf(submitted.payload, key.apiKey);
    if (!accepted) {
      console.error("AthanLab returned no speech job", { replayed });
      return failure(c, 502, "AthanLab returned no speech job", "unexpected_response");
    }
    if (!replayed) freshJobs++;

    let job = accepted;
    if (job.status === "processing") {
      const firstWaitMs =
        retryAfterSeconds === null
          ? DEFAULT_FIRST_POLL_MS
          : Math.max(MIN_FIRST_POLL_MS, retryAfterSeconds * 1000);
      const polled = await pollJob(context, job.id, firstWaitMs);
      switch (polled.kind) {
        case "still_processing":
          return stillProcessing(c);
        case "unexpected":
          console.error("AthanLab returned an unexpected job while polling");
          return failure(
            c,
            502,
            "AthanLab returned an unexpected speech job",
            "unexpected_response",
          );
        case "rejected":
        case "unavailable":
          return outcomeFailure(c, key, polled, "poll");
        case "finished":
          job = polled.job;
      }
    }

    if (job.status === "succeeded") {
      const downloaded = await downloadAudio(c, key, context, job.id);
      if (downloaded.kind !== "expired") return downloaded.response;
      lastFailure = {
        message: describeAthanLabError(downloaded.error),
        code: downloaded.error.code ?? "audio_expired",
      };
    } else if (job.status === "failed") {
      const message = job.error?.message ?? "the job failed";
      const code = job.error?.code ?? "generation_failed";
      if (!job.error?.retryable) {
        console.error("AthanLab job failed", { code, retryable: false });
        return failure(c, 502, `AthanLab could not speak this dialog: ${message}`, code);
      }
      lastFailure = { message, code };
    } else {
      lastFailure = { message: "the job was cancelled", code: "cancelled" };
    }

    if (freshJobs >= MAX_FRESH_JOBS) break;
  }

  console.error("AthanLab gave up on a dialog", { code: lastFailure.code, freshJobs });
  return failure(
    c,
    502,
    `AthanLab could not speak this dialog: ${lastFailure.message}`,
    lastFailure.code,
  );
}
