// Lesson assets are served same-origin from the host app's public/ folder.
export function resolveThumb(path: string): string {
  return `/${path}`;
}
