import type {
  ApiClientRecordedRequest,
  ApiClientRecordedResult,
  ApiClientReplayState,
} from "../types/slides";
import type {
  ApiClientHeader,
  ApiClientReplayPayload,
  ApiClientResult,
  HttpMethod,
} from "./apiClientStore";

// How the API client is recorded and replayed: between the store's nested shape and the
// flat shape a recording's preview events carry. useApiClient and the preview
// controller record with these; the controller's replay shows a recorded state through
// the store's applyReplayState.

/** Collapse the editable header rows into the enabled, non-empty header map that
 *  is actually sent (and recorded). */
function buildHeaderRecord(headers: ApiClientHeader[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const header of headers) {
    const key = header.key.trim();
    if (header.enabled && key) {
      record[key] = header.value;
    }
  }
  return record;
}

/** A request as it is sent and recorded: the enabled headers as a map, and no body on
 *  a GET (an empty body is none too). */
export function toRecordedApiRequest({
  method,
  path,
  headers,
  body,
}: {
  method: HttpMethod;
  path: string;
  headers: ApiClientHeader[];
  body: string;
}): ApiClientRecordedRequest {
  return {
    method,
    path,
    headers: buildHeaderRecord(headers),
    body: method === "GET" ? undefined : body || undefined,
  };
}

/** Expand a recorded header map back into editable rows (used on replay). */
function recordToHeaders(record: Record<string, string>): ApiClientHeader[] {
  return Object.entries(record).map(([key, value]) => ({ key, value, enabled: true }));
}

/** Maps a recorded (flat) result back into the store's nested result shape, used
 *  when replaying a recording's API client interactions. */
export function recordedResultToStoreResult(recorded: ApiClientRecordedResult): ApiClientResult {
  return recorded.ok
    ? {
        ok: true,
        response: {
          status: recorded.status,
          statusText: recorded.statusText,
          headers: recorded.headers,
          body: recorded.body,
          durationMs: recorded.durationMs,
          truncated: recorded.truncated,
          bodyBytes: recorded.bodyBytes,
        },
      }
    : { ok: false, error: { error: recorded.error, durationMs: recorded.durationMs } };
}

/** Maps a recording's API client state onto what `applyReplayState` shows. */
export function recordedApiStateToReplayPayload(
  apiState: ApiClientReplayState,
): ApiClientReplayPayload {
  const request = apiState.request;
  return {
    method: (request?.method ?? "GET") as HttpMethod,
    path: request?.path ?? "/",
    body: request?.body ?? "",
    headers: request ? recordToHeaders(request.headers) : [],
    sending: apiState.sending ?? false,
    result: apiState.result ? recordedResultToStoreResult(apiState.result) : null,
    history: (apiState.history ?? []).map((entry) => ({
      id: entry.id,
      method: (entry.request?.method ?? "GET") as HttpMethod,
      path: entry.request?.path ?? "/",
      headers: recordToHeaders(entry.request?.headers ?? {}),
      body: entry.request?.body ?? "",
      result: recordedResultToStoreResult(entry.result),
      timestamp: 0,
    })),
  };
}

/** Inverse of {@link recordedResultToStoreResult}: flattens a store result for
 *  recording (e.g. when a history entry is inspected during a capture). */
export function storeResultToRecorded(result: ApiClientResult): ApiClientRecordedResult {
  return result.ok
    ? {
        ok: true,
        status: result.response.status,
        statusText: result.response.statusText,
        headers: result.response.headers,
        body: result.response.body,
        durationMs: result.response.durationMs,
        truncated: result.response.truncated,
        bodyBytes: result.response.bodyBytes,
      }
    : { ok: false, error: result.error.error, durationMs: result.error.durationMs };
}
