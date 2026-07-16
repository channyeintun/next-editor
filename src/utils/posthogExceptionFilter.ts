const WEBCONTAINER_PREVIEW_ORIGIN_PATTERN =
  /(?:https?:\/\/|blob:https?:\/\/)[^\s/]*(?:webcontainer-api\.io|webcontainer\.io)(?=[:/\s]|$)/i;

/** Blocks the complete editor subtree; the narrower selectors cover legacy embeds. */
export const POSTHOG_SENSITIVE_SURFACE_SELECTOR = ".ph-no-capture, .monaco-editor, .excalidraw";

type PostHogEvent = {
  event?: string;
  properties?: Record<string, unknown>;
};

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
