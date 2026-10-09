// The parts of the playground contracts every language shares: the source file
// shape, the `{ files }` request body, and the format response check. Each
// language's types.ts builds on these and adds what genuinely differs — its run
// statuses and its run-result parser.
//
// Deliberately free of imports: the Worker routes (infra/worker/routes/
// *Playground.ts) import the per-language types.ts files, and those must stay
// light enough to compile without the app's DOM and workspace types.

/** A lesson source file as every playground client takes it. */
export interface PlaygroundFile {
  path: string;
  content: string;
}

/** The body of every playground run and format request. */
export interface PlaygroundFilesRequest {
  files: readonly PlaygroundFile[];
}

/** What a formatter answers with: every submitted file, laid out. */
export interface PlaygroundFormatResult {
  files: PlaygroundFile[];
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * Validate a normalized multi-file format response, or null when it does not
 * match the contract: a non-empty list of files with distinct, non-empty paths
 * and string contents. Unknown extra fields are dropped.
 */
export function parsePlaygroundFormatResult(value: unknown): PlaygroundFormatResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const rawFiles = (value as Record<string, unknown>).files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return null;
  }

  const files: PlaygroundFile[] = [];
  const seenPaths = new Set<string>();
  for (const rawFile of rawFiles) {
    if (typeof rawFile !== "object" || rawFile === null) {
      return null;
    }

    const candidate = rawFile as Record<string, unknown>;
    if (
      typeof candidate.path !== "string" ||
      candidate.path.length === 0 ||
      typeof candidate.content !== "string" ||
      seenPaths.has(candidate.path)
    ) {
      return null;
    }

    seenPaths.add(candidate.path);
    files.push({ path: candidate.path, content: candidate.content });
  }

  return { files };
}
