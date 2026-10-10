/**
 * The wire contract between the Worker's AthanLab routes
 * (infra/worker/routes/athanlab.ts) and the page that drives them
 * (athanlabSynth.ts, AthanLabPanel.tsx). Both sides import it, so a limit or
 * an error code changed on one side cannot drift from the other.
 */

/** AthanLab's per-request text limit, in UTF-16 code units (`String.length`). */
export const ATHANLAB_MAX_TEXT_CHARS = 5_000;

/**
 * Worker answers that the same request succeeds if asked again later, with the
 * status each comes with and how many more POSTs the page allows per dialog:
 * the job is still running when the Worker's own time ran out
 * (`still_processing`), this user's per-minute AthanLab budget is spent
 * (`rate_limited` — a replay of already-bought takes can outrun it), or another
 * request of this user is first checking the saved key (`key_busy`). The page
 * retries a code only with its status here: AthanLab's own codes are relayed
 * as they come, and one of them could share a name.
 */
export const ATHANLAB_RETRY_LATER = {
  still_processing: { status: 503, retries: 4 },
  rate_limited: { status: 429, retries: 3 },
  key_busy: { status: 503, retries: 3 },
} as const satisfies Record<string, { status: number; retries: number }>;

export type AthanLabRetryLaterCode = keyof typeof ATHANLAB_RETRY_LATER;

/** Worker codes that mean the saved key cannot be used until it is connected again. */
export const ATHANLAB_RECONNECT_CODES = ["key_missing", "key_invalid", "key_stale"] as const;

export type AthanLabReconnectCode = (typeof ATHANLAB_RECONNECT_CODES)[number];

/**
 * Every error code the Worker's AthanLab routes answer with of their own.
 * Besides these, the Worker relays AthanLab's own error codes as they come.
 */
export type AthanLabErrorCode =
  | AthanLabRetryLaterCode
  | AthanLabReconnectCode
  | "not_configured"
  | "auth_blocked"
  | "key_checks_paused"
  | "unavailable"
  | "api_read_only"
  | "invalid_api_key"
  | "invalid_format"
  | "scope_missing"
  | "invalid_request"
  | "invalid_text"
  | "invalid_voice"
  | "unexpected_response"
  | "sample_unavailable"
  | "generation_failed"
  | "audio_expired"
  | "cancelled";

/**
 * Whether a code read off the wire is one of `table`'s own keys — never an
 * inherited Object.prototype member such as "constructor".
 */
export function isOwnCodeOf<Table extends object>(
  table: Table,
  code: string,
): code is Extract<keyof Table, string> {
  return Object.hasOwn(table, code);
}
