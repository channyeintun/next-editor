import { sanitizeSlideContent } from "./sanitizeSlideContent";

const SLIDE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src https: data: blob:",
  "media-src https: data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Build a script-disabled iframe document for authored/imported slide markup.
 * CSS remains fully expressive inside the frame but cannot select or cover the
 * editor's host document. The CSP also prevents stylesheets, scripts, forms,
 * network APIs, and top-level base URL changes while retaining slide images.
 */
export function createSandboxedSlideDocument(
  content: string,
  mimeType: "text/html" | "image/svg+xml",
): string {
  const sanitized = sanitizeSlideContent(content, mimeType);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${SLIDE_CONTENT_SECURITY_POLICY}">
    <meta name="referrer" content="no-referrer">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #000; }
      body { display: flex; align-items: center; justify-content: center; }
      body > svg { display: block; width: 100%; height: auto; }
    </style>
  </head>
  <body>${sanitized}</body>
</html>`;
}
