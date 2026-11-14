import { narrationRequestsOf } from "../inPageDirector";
import { hasCachedDialogWav, isDialogCacheAvailable } from "../tts/dialogCache";
import type { NarrationPackLesson } from "./requestPack";

/**
 * Offline narration, the question between the import and the render: which of
 * these lessons can this browser narrate by itself, and what would a render
 * still ask the speech service for. Imported audio comes in parts of a few
 * dozen dialogs, so the number of files imported says nothing about lessons;
 * a lesson is covered only when every one of its dialogs has a take here.
 *
 * The requests are the ones a render makes (narrationRequestsOf), and a take
 * counts as kept exactly when a render would find it (hasCachedDialogWav).
 */

export interface LessonNarrationCoverage {
  slug: string;
  /** The lesson's distinct speech requests. */
  dialogCount: number;
  /** Those with no take in this browser: a render asks the speech service for them. */
  missingCount: number;
}

export interface NarrationCoverage {
  /** One entry per lesson, in the order asked. */
  lessons: LessonNarrationCoverage[];
  /** Distinct requests with no take here, across the lessons (two lessons can share one). */
  missingDialogCount: number;
  /** Characters of speech text in those requests. */
  missingCharacterCount: number;
  /** Why this browser cannot tell which takes it keeps, so every dialog counts as missing. */
  cacheUnavailable: string | null;
}

/** What the count asks of the rest of the studio; tests replace it. */
export interface NarrationCoverageDeps {
  requestsOf: typeof narrationRequestsOf;
  hasCached: typeof hasCachedDialogWav;
  cacheAvailable: typeof isDialogCacheAvailable;
}

/**
 * How much of these lessons' narration this browser keeps. Rejects with the
 * signal's reason once it is aborted: a count for a selection that has changed
 * is not worth the lookups.
 */
export async function narrationCoverageOf(
  lessons: readonly NarrationPackLesson[],
  { signal, deps = {} }: { signal?: AbortSignal; deps?: Partial<NarrationCoverageDeps> } = {},
): Promise<NarrationCoverage> {
  const requestsOf = deps.requestsOf ?? narrationRequestsOf;
  const hasCached = deps.hasCached ?? hasCachedDialogWav;
  const cacheAvailable = deps.cacheAvailable ?? isDialogCacheAvailable;
  let cacheUnavailable: string | null = cacheAvailable()
    ? null
    : "Cache storage is not available in this page";
  // One lookup per request, however many lessons ask for it.
  const kept = new Map<string, Promise<boolean>>();
  const isKept = (requestHash: string): Promise<boolean> => {
    let lookup = kept.get(requestHash);
    if (!lookup) {
      lookup = hasCached(requestHash, (reason) => {
        cacheUnavailable ??= reason;
      });
      kept.set(requestHash, lookup);
    }
    return lookup;
  };
  /** Request hash → characters of its speech text. */
  const missing = new Map<string, number>();
  const covered: LessonNarrationCoverage[] = [];

  for (const { slug, script, voiceProfile } of lessons) {
    if (signal?.aborted) throw signal.reason;
    const { requests } = await requestsOf(script, { voiceProfile });
    const distinct = new Map(requests.map((request) => [request.requestHash, request]));
    const lookups = await Promise.all(
      [...distinct.values()].map(async (request) => ({
        request,
        kept: await isKept(request.requestHash),
      })),
    );
    let missingCount = 0;
    for (const { request, kept: found } of lookups) {
      if (found) continue;
      missingCount += 1;
      missing.set(request.requestHash, request.speechText.length);
    }
    covered.push({ slug, dialogCount: distinct.size, missingCount });
  }

  return {
    lessons: covered,
    missingDialogCount: missing.size,
    missingCharacterCount: [...missing.values()].reduce((sum, characters) => sum + characters, 0),
    cacheUnavailable,
  };
}
