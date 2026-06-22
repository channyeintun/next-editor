import type { WebContainerRuntimeStatus } from "../../contexts/WebContainerRuntimeContext";

// ============================================================================
// Runtime preview helpers
//
// Pure helpers behind `usePreviewController` for the WebContainer ("runtime")
// preview: parsing/normalizing the live preview URL and route, deriving the
// status placeholder copy, and rendering the placeholder document. No React or
// hook state here — kept separate so the controller hook reads as wiring.
// ============================================================================

// ----------------------------------------------------------------------------
// Location & route
// ----------------------------------------------------------------------------

export interface RuntimePreviewLocation {
  href: string;
  port: number | null;
  route: string;
}

function getUrlPort(url: URL): number | null {
  const port = Number(url.port);

  return Number.isFinite(port) && port > 0 ? port : null;
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function formatPreviewRoute(pathname: string, search: string, hash: string): string {
  const normalizedPathname = pathname.startsWith("/") ? pathname : `/${pathname || ""}`;
  const route = `${normalizedPathname || "/"}${search}${hash}`;

  return route || "/";
}

export function normalizePreviewRoute(route: string): string {
  const trimmedRoute = route.trim();

  if (!trimmedRoute) {
    return "/";
  }

  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedRoute)) {
      const parsedUrl = new URL(trimmedRoute);
      return formatPreviewRoute(parsedUrl.pathname || "/", parsedUrl.search, parsedUrl.hash);
    }
  } catch {
    // Treat malformed values as relative routes.
  }

  if (trimmedRoute.startsWith("/")) {
    return trimmedRoute;
  }

  if (trimmedRoute.startsWith("?") || trimmedRoute.startsWith("#")) {
    return `/${trimmedRoute}`;
  }

  return `/${trimmedRoute}`;
}

export function createRuntimePreviewLocationFromUrl(
  url: string | null,
  fallbackPort: number | null,
): RuntimePreviewLocation | null {
  if (!url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);

    if (!isHttpUrl(parsedUrl)) {
      return null;
    }

    return {
      href: parsedUrl.href,
      port: fallbackPort ?? getUrlPort(parsedUrl),
      route: formatPreviewRoute(parsedUrl.pathname || "/", parsedUrl.search, parsedUrl.hash),
    };
  } catch {
    return {
      href: url,
      port: fallbackPort,
      route: "/",
    };
  }
}

export function formatPreviewAddressLabel(location: RuntimePreviewLocation | null): string {
  if (!location) {
    return "Preview";
  }

  return location.port === null ? location.route : `:${location.port} ${location.route}`;
}

export function applyRouteToRuntimePreviewLocation(
  location: RuntimePreviewLocation | null,
  route: string,
): RuntimePreviewLocation | null {
  if (!location) {
    return null;
  }

  const normalizedRoute = normalizePreviewRoute(route);

  try {
    const routeUrl = new URL(normalizedRoute, location.href);

    return {
      ...location,
      href: routeUrl.href,
      route: normalizedRoute,
    };
  } catch {
    return {
      ...location,
      route: normalizedRoute,
    };
  }
}

export async function refreshRuntimePreview(
  iframe: HTMLIFrameElement,
  fallbackUrl: string,
): Promise<void> {
  try {
    const { reloadPreview } = await import("@webcontainer/api");
    reloadPreview(iframe);
  } catch {
    iframe.removeAttribute("srcdoc");
    iframe.src = fallbackUrl;
  }
}

// ----------------------------------------------------------------------------
// Status placeholder
// ----------------------------------------------------------------------------

function escapePreviewHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function getRuntimePreviewState(
  status: WebContainerRuntimeStatus,
  errorMessage: string | null,
  isSupported: boolean,
): {
  label: string;
  title: string;
  description: string;
  placeholderKind: "spinner" | "message";
} {
  if (!isSupported) {
    return {
      label: "Runtime preview unavailable",
      title: "Runtime preview unavailable",
      description:
        "The live runtime needs a desktop Chromium or Firefox browser with cross-origin isolation. It isn't available on mobile browsers.",
      placeholderKind: "message",
    };
  }

  if (status === "error") {
    return {
      label: "Runtime preview error",
      title: "Runtime preview failed",
      description: errorMessage ?? "Check the runner output, fix the error, and rerun the preview.",
      placeholderKind: "message",
    };
  }

  if (status === "installing") {
    return {
      label: "Installing runtime",
      title: "Installing dependencies",
      description: "The project is preparing packages before the live preview can start.",
      placeholderKind: "spinner",
    };
  }

  if (status === "starting") {
    return {
      label: "Starting runtime",
      title: "Starting live preview",
      description: "The dev server is booting and will replace this placeholder when it is ready.",
      placeholderKind: "spinner",
    };
  }

  if (status === "mounting" || status === "booting") {
    return {
      label: "Preparing runtime",
      title: "Preparing runtime preview",
      description: "The workspace is mounting into the WebContainer before the preview starts.",
      placeholderKind: "spinner",
    };
  }

  return {
    label: "Runtime preview",
    title: "Runtime preview is waiting",
    description: "Run or rerun the project to open the live app preview here.",
    placeholderKind: "spinner",
  };
}

export function createRuntimePreviewPlaceholder(
  placeholderKind: "spinner" | "message",
  title: string,
  description: string,
): string {
  if (placeholderKind === "spinner") {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f8fafc;
      }

      .spinner {
        width: 32px;
        height: 32px;
        border-radius: 999px;
        border: 3px solid rgba(148, 163, 184, 0.28);
        border-top-color: #0f766e;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    </style>
  </head>
  <body>
    <div class="spinner" role="status" aria-label="${escapePreviewHtml(title)}"></div>
  </body>
</html>`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light;
        font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
        background: #f6f7fb;
        color: #0f172a;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(125, 211, 252, 0.18), transparent 35%),
          linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
      }

      main {
        width: min(420px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.28);
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
      }

      .eyebrow {
        margin: 0 0 14px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #0f766e;
      }

      h1 {
        margin: 0;
        font-size: 28px;
        line-height: 1.15;
      }

      p {
        margin: 14px 0 0;
        font-size: 15px;
        line-height: 1.6;
        color: #334155;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Runtime Preview</p>
      <h1>${escapePreviewHtml(title)}</h1>
      <p>${escapePreviewHtml(description)}</p>
    </main>
  </body>
</html>`;
}
