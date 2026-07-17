export interface PreviewTarget {
  sessionId: string;
  port: number;
  path: string;
}

export function previewTarget(request: Request): PreviewTarget | null {
  const url = new URL(request.url);
  const pathMatch = url.pathname.match(/^\/preview\/([0-9a-f-]+)\/(\d+)(\/.*)?$/);
  if (pathMatch)
    return { sessionId: pathMatch[1]!, port: Number(pathMatch[2]), path: pathMatch[3] ?? "/" };
  const hostMatch = url.hostname.match(/^p(\d+)-([0-9a-f-]+)(?:\.|-preview\.)/);
  if (hostMatch)
    return { sessionId: hostMatch[2]!, port: Number(hostMatch[1]), path: url.pathname };
  return null;
}
