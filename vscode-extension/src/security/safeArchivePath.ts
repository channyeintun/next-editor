// Archive entry-name safety (plan §13.2). Applied before any entry is
// read; imported recordings are untrusted input.
export type ArchivePathVerdict = { ok: true; normalized: string } | { ok: false; reason: string };

export function validateArchivePath(entryName: string): ArchivePathVerdict {
  if (entryName.length === 0 || entryName.length > 1024) {
    return { ok: false, reason: "entry name empty or too long" };
  }
  if (entryName.includes("\0")) {
    return { ok: false, reason: "NUL byte in entry name" };
  }
  const normalized = entryName.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return { ok: false, reason: "absolute path" };
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    return { ok: false, reason: "drive-letter path" };
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "") {
      return { ok: false, reason: "empty path segment" };
    }
    if (segment === "." || segment === "..") {
      return { ok: false, reason: "path traversal segment" };
    }
  }
  return { ok: true, normalized };
}
