const WEBCONTAINER_PREVIEW_ORIGIN_PATTERN =
  /(?:https?:\/\/|blob:https?:\/\/)[^\s/]*(?:webcontainer-api\.io|webcontainer\.io)(?=[:/\s]|$)/i;

/** Blocks the complete editor subtree; the narrower selectors cover legacy embeds. */
export const POSTHOG_SENSITIVE_ROOT_CLASS = "ph-no-capture";
export const POSTHOG_SENSITIVE_SURFACE_SELECTOR = `.${POSTHOG_SENSITIVE_ROOT_CLASS}, .monaco-editor, .excalidraw`;

export type PostHogEvent = {
  event?: string;
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
};

const SAFE_EXCEPTION_TYPE_PATTERN = /^[A-Za-z_$][\w$.-]{0,127}$/;
const SENSITIVE_EXCEPTION_PROPERTY_PATTERN =
  /(?:breadcrumb|console|command|message|error|stack|fingerprint|token|secret|authorization|cookie|credential|password|headers?|request[_-]?(?:body|data)|response[_-]?(?:body|data)|source[_-]?(?:code|line))/i;
const URL_EXCEPTION_PROPERTY_PATTERN = /(?:url|uri|href|referrer|pathname)$/i;

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
 */
export function sanitizePostHogEvent<T extends PostHogEvent>(
  event: T | null | undefined,
): T | null {
  if (!event || !shouldSendPostHogEvent(event)) {
    return null;
  }

  if (event.event !== "$exception") {
    return event;
  }

  const properties = { ...(event.properties ?? {}) };
  properties.$exception_list = sanitizeExceptionList(properties.$exception_list);

  for (const key of Object.keys(properties)) {
    if (SENSITIVE_EXCEPTION_PROPERTY_PATTERN.test(key)) {
      delete properties[key];
    } else if (URL_EXCEPTION_PROPERTY_PATTERN.test(key)) {
      properties[key] = sanitizeTelemetryUrl(properties[key]);
    }
  }

  const sanitized = { ...event, properties } as T;
  delete sanitized.$set;
  delete sanitized.$set_once;
  return sanitized;
}
