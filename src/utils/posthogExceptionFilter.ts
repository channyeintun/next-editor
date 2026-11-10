import type { PostHogConfig } from "posthog-js";

const WEBCONTAINER_PREVIEW_ORIGIN_PATTERN =
  /(?:https?:\/\/|blob:https?:\/\/)[^\s/]*(?:webcontainer-api\.io|webcontainer\.io)(?=[:/\s]|$)/i;

/** Blocks the complete editor subtree; the narrower selectors cover legacy embeds. */
export const POSTHOG_SENSITIVE_ROOT_CLASS = "ph-no-capture";
export const POSTHOG_SENSITIVE_SURFACE_SELECTOR = `.${POSTHOG_SENSITIVE_ROOT_CLASS}, .monaco-editor, .excalidraw`;

/**
 * The session-replay half of docs/observability-privacy.md, spread into `posthog.init`.
 * Workspace source, filenames, previews, runtime/agent/API output, slides, recordings and
 * drawings must not land in third-party replays: the editor root is blocked and inputs are
 * masked. Console capture is pinned off because the WebContainer runtime mirrors runner
 * output to the console, and left undefined PostHog follows the project's remote setting.
 * Network body and header capture are pinned off for the same reason: unless the client
 * says `false`, a dashboard setting can turn them on, and PostHog's default payload
 * scrubber misses camel-case fields such as the `apiKey` the AthanLab key save sends.
 */
export const POSTHOG_REPLAY_PRIVACY_OPTIONS = {
  enable_recording_console_log: false,
  session_recording: {
    maskAllInputs: true,
    blockSelector: POSTHOG_SENSITIVE_SURFACE_SELECTOR,
    recordBody: false,
    recordHeaders: false,
    // Replay records the page URL (and each captured request's) through this
    // hook, so it loses its query and fragment there, as event URLs do.
    maskCapturedNetworkRequestFn: (request) => ({
      ...request,
      name: withoutUrlQuery(request.name),
    }),
  },
} satisfies Partial<PostHogConfig>;

export type PostHogEvent = {
  event?: string;
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
};

const SAFE_EXCEPTION_TYPE_PATTERN = /^[A-Za-z_$][\w$.-]{0,127}$/;
const SENSITIVE_EXCEPTION_PROPERTY_PATTERN =
  /(?:breadcrumb|console|command|message|error|stack|fingerprint|token|secret|authorization|cookie|credential|password|headers?|request[_-]?(?:body|data)|response[_-]?(?:body|data)|source[_-]?(?:code|line))/i;
const URL_PROPERTY_PATTERN = /(?:url|uri|href|referrer|pathname)$/i;

function containsWebContainerPreviewOrigin(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") {
    return WEBCONTAINER_PREVIEW_ORIGIN_PATTERN.test(value);
  }

  if (!value || typeof value !== "object" || seen.has(value)) {
    return false;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((entry) => containsWebContainerPreviewOrigin(entry, seen));
  }

  return Object.values(value).some((entry) => containsWebContainerPreviewOrigin(entry, seen));
}

/**
 * WebContainer forwards errors from users' preview iframes so the editor can
 * display them. Those errors belong to the user's project, not this app, and
 * must not become PostHog Error Tracking issues for Next Editor.
 */
export function shouldSendPostHogEvent(event: PostHogEvent | null | undefined): boolean {
  if (!event || event.event !== "$exception") {
    return true;
  }

  return !containsWebContainerPreviewOrigin(event.properties?.$exception_list);
}

function sanitizeTelemetryUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  try {
    const url = new URL(
      value,
      typeof window === "undefined" ? "https://next-editor.invalid" : window.location.href,
    );
    return `${url.origin}${url.pathname}`.slice(0, 1024);
  } catch {
    return value.replace(/[?#].*$/, "").slice(0, 1024);
  }
}

/**
 * A URL with its query and fragment cut off; any other string is returned as
 * is (PostHog writes "$direct" where there is no referrer). Queries carry
 * authored values and credentials: a lesson URL in ?url=, a room invitation's
 * bearer token in ?invite=, which docs/observability-privacy.md classes as
 * Secret. Paths stay for navigation analytics.
 */
export function withoutUrlQuery(value: string): string {
  const end = value.search(/[?#]/);
  return end === -1 ? value : value.slice(0, end);
}

function isPropertyRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The properties with every URL-valued one (and those in a nested $set/$set_once) query-free. */
function withoutUrlQueries(properties: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    stripped[key] =
      (key === "$set" || key === "$set_once") && isPropertyRecord(value)
        ? withoutUrlQueries(value)
        : typeof value === "string" && URL_PROPERTY_PATTERN.test(key)
          ? withoutUrlQuery(value)
          : value;
  }
  return stripped;
}

function sanitizeExceptionFrame(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const frame = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  const filename = sanitizeTelemetryUrl(frame.filename);
  if (filename) sanitized.filename = filename;
  if (typeof frame.lineno === "number" && Number.isFinite(frame.lineno)) {
    sanitized.lineno = Math.max(0, Math.trunc(frame.lineno));
  }
  if (typeof frame.colno === "number" && Number.isFinite(frame.colno)) {
    sanitized.colno = Math.max(0, Math.trunc(frame.colno));
  }
  if (typeof frame.in_app === "boolean") sanitized.in_app = frame.in_app;
  return sanitized;
}

function sanitizeExceptionList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const exception = entry as Record<string, unknown>;
    const type =
      typeof exception.type === "string" && SAFE_EXCEPTION_TYPE_PATTERN.test(exception.type)
        ? exception.type
        : "Error";
    const stacktrace =
      exception.stacktrace && typeof exception.stacktrace === "object"
        ? (exception.stacktrace as Record<string, unknown>)
        : null;
    const frames = Array.isArray(stacktrace?.frames)
      ? stacktrace.frames
          .slice(-100)
          .map(sanitizeExceptionFrame)
          .filter((frame): frame is Record<string, unknown> => frame !== null)
      : [];

    return [
      {
        type,
        value: "[redacted]",
        ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
      },
    ];
  });
}

/**
 * Drop preview-origin exceptions and remove messages, source excerpts,
 * breadcrumbs, commands, and request/response bodies from application errors.
 * This is separate from session-replay DOM blocking: exception autocapture does
 * not honor `blockSelector` for Error objects.
 *
 * Every other event keeps its properties, but no URL in them keeps a query or
 * fragment. PostHog copies location.href into $current_url, into the session's
 * $session_entry_url (sent with every later event of the session, after the
 * page has dropped the query) and into first-visit person properties, so an
 * invitee's /code?invite=<token> would otherwise reach the analytics project.
 */
export function sanitizePostHogEvent<T extends PostHogEvent>(
  event: T | null | undefined,
): T | null {
  if (!event || !shouldSendPostHogEvent(event)) {
    return null;
  }

  if (event.event !== "$exception") {
    const sanitized = { ...event };
    if (event.properties) sanitized.properties = withoutUrlQueries(event.properties);
    if (event.$set) sanitized.$set = withoutUrlQueries(event.$set);
    if (event.$set_once) sanitized.$set_once = withoutUrlQueries(event.$set_once);
    return sanitized;
  }

  const properties = { ...event.properties };
  properties.$exception_list = sanitizeExceptionList(properties.$exception_list);

  for (const key of Object.keys(properties)) {
    if (SENSITIVE_EXCEPTION_PROPERTY_PATTERN.test(key)) {
      delete properties[key];
    } else if (URL_PROPERTY_PATTERN.test(key)) {
      properties[key] = sanitizeTelemetryUrl(properties[key]);
    }
  }

  const sanitized = { ...event, properties } as T;
  delete sanitized.$set;
  delete sanitized.$set_once;
  return sanitized;
}
