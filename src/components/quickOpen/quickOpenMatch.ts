import type { WorkspaceTreeFile } from "../../types/workspace";
import { FUZZY_MATCH_MAX_LENGTH, foldCase, fuzzyMatch } from "../../monaco/fuzzyMatch";

// ============================================================================
// Go to File's ranking, after VS Code's Quick Open (scoreItemFuzzy and
// compareItemsByFuzzyScore in its fuzzyScorer): a query that matches a file's
// name beats one that only matches its folders, a name that starts with the
// query beats both, a name that holds the query as one run beats the same
// letters scattered through another, and shorter names win among those. The
// letter matching is Monaco's own fuzzyScore.
// ============================================================================

/** At most this many results are drawn; `total` still counts every match. */
export const QUICK_OPEN_RESULT_LIMIT = 100;

// VS Code's tiers. Monaco's per-word scores stay far below 1 << 15, so a tier
// always outranks every score inside the tier below it. Pieces add up, so a
// several-word query can pass 1 << 18; an identity match sorts first anyway.
const PATH_IDENTITY_SCORE = 1 << 18;
const NAME_PREFIX_SCORE = 1 << 17;
const NAME_SCORE = 1 << 16;
/** Added to NAME_SCORE for a piece found whole inside the name, as one run. */
const NAME_RUN_SCORE = 1 << 15;
/** Shorter pieces stay acronyms: "fs" is FileSidebar.tsx, not offsets.ts. */
const NAME_RUN_MIN_LENGTH = 3;

export interface QuickOpenCandidate {
  file: WorkspaceTreeFile;
  path: string;
  folded: string;
  /** Where the file name starts in `path`. */
  nameStart: number;
  /** Position in the store's list (sorted by path), the last tie-break. */
  order: number;
}

export interface QuickOpenResult {
  file: WorkspaceTreeFile;
  name: string;
  /** The folder path, without the slash before the name; "" at the root. */
  directory: string;
  nameMatches: number[];
  directoryMatches: number[];
}

interface QueryPiece {
  text: string;
  folded: string;
}

interface ScoredCandidate {
  candidate: QuickOpenCandidate;
  /** The query is this file's whole path; it sorts above every other match. */
  identity: boolean;
  score: number;
  positions: number[];
}

/** Per-file work that does not depend on the query, done once per file list. */
export function prepareQuickOpenCandidates(files: WorkspaceTreeFile[]): QuickOpenCandidate[] {
  return files.map((file, order) => ({
    file,
    path: file.path,
    folded: foldCase(file.path),
    nameStart: file.path.lastIndexOf("/") + 1,
    order,
  }));
}

/**
 * Query text as VS Code reads it: a backslash is a path separator, and quotes,
 * `*` and `…` are dropped. Paths here have no leading "./" or "/", so neither
 * does a query or a piece of one.
 */
function normalizeQueryText(text: string): string {
  return text
    .replaceAll("\\", "/")
    .replace(/[*…"]/g, "")
    .replace(/^(?:\.\/|\/)+/, "");
}

/** Whitespace splits the query into pieces that must all match. */
function prepareQuery(rawQuery: string): QueryPiece[] {
  return rawQuery
    .split(/\s+/)
    .map(normalizeQueryText)
    .filter(Boolean)
    .map((text) => ({ text, folded: foldCase(text) }));
}

/**
 * Monaco reads only the first 128 characters, so a longer path is matched by
 * its start and by its end, and the better of the two counts. A piece that
 * needs letters from both ends of such a path still misses it.
 */
function matchPath(piece: QueryPiece, candidate: QuickOpenCandidate) {
  const tailStart = Math.max(0, candidate.path.length - FUZZY_MATCH_MAX_LENGTH);
  let best: { score: number; positions: number[] } | null = null;
  for (const offset of tailStart ? [tailStart, 0] : [0]) {
    const match = fuzzyMatch(
      piece.text,
      piece.folded,
      candidate.path.slice(offset),
      candidate.folded.slice(offset),
    );
    if (match && (!best || match.score > best.score)) {
      best = { score: match.score, positions: match.positions.map((at) => at + offset) };
    }
  }
  return best;
}

/** One piece against one file: its name first unless the query names folders, then its path. */
function scorePiece(
  piece: QueryPiece,
  candidate: QuickOpenCandidate,
  preferName: boolean,
): { score: number; positions: number[] } | null {
  const { nameStart } = candidate;
  if (preferName) {
    const name = candidate.path.slice(nameStart);
    const foldedName = candidate.folded.slice(nameStart);
    const match = fuzzyMatch(piece.text, piece.folded, name, foldedName);
    if (match) {
      const positions = match.positions.map((at) => at + nameStart);
      // Typing a file's name wins over the same letters found inside another
      // name, and the more of the name it covers, the higher: "window" puts
      // window.ts above windowActions.ts.
      if (foldedName.startsWith(piece.folded)) {
        const base = NAME_PREFIX_SCORE + Math.round((piece.text.length / name.length) * 100);
        return { score: base + match.score, positions };
      }
      // Typing a run of the name as it is written ("icons" in fileIcons.tsx)
      // wins over the same letters spread over humps (IconCursor.tsx), which
      // Monaco scores higher for starting earlier.
      const runStart =
        piece.folded.length >= NAME_RUN_MIN_LENGTH ? foldedName.indexOf(piece.folded) : -1;
      if (runStart >= 0) {
        // Highlight a run: Monaco's own letters when they are one (the hump in
        // contestTest.ts), else the first run in the name.
        const run =
          matchSpan(positions) === positions.length - 1
            ? positions
            : Array.from(
                { length: piece.folded.length },
                (_, index) => nameStart + runStart + index,
              );
        return { score: NAME_SCORE + NAME_RUN_SCORE + match.score, positions: run };
      }
      return { score: NAME_SCORE + match.score, positions };
    }
  }
  return matchPath(piece, candidate);
}

function scoreCandidate(
  pieces: QueryPiece[],
  candidate: QuickOpenCandidate,
  preferName: boolean,
  wholeQuery: string,
): ScoredCandidate | null {
  if (candidate.folded === wholeQuery) {
    return {
      candidate,
      identity: true,
      score: PATH_IDENTITY_SCORE,
      // By UTF-16 unit, as every other position is.
      positions: Array.from({ length: candidate.path.length }, (_, index) => index),
    };
  }
  let score = 0;
  const positions = new Set<number>();
  for (const piece of pieces) {
    const match = scorePiece(piece, candidate, preferName);
    if (!match) return null;
    score += match.score;
    for (const position of match.positions) positions.add(position);
  }
  return {
    candidate,
    identity: false,
    score,
    positions: [...positions].sort((left, right) => left - right),
  };
}

/** How spread out the match is: from its first matched letter to its last. */
function matchSpan(positions: number[]): number {
  return positions.length ? positions[positions.length - 1] - positions[0] : 0;
}

function compareScored(left: ScoredCandidate, right: ScoredCandidate): number {
  return (
    Number(right.identity) - Number(left.identity) ||
    right.score - left.score ||
    matchSpan(left.positions) - matchSpan(right.positions) ||
    left.candidate.path.length -
      left.candidate.nameStart -
      (right.candidate.path.length - right.candidate.nameStart) ||
    left.candidate.path.length - right.candidate.path.length ||
    left.candidate.order - right.candidate.order
  );
}

function toResult(candidate: QuickOpenCandidate, positions: number[]): QuickOpenResult {
  const { nameStart, path } = candidate;
  return {
    file: candidate.file,
    name: path.slice(nameStart),
    directory: nameStart > 0 ? path.slice(0, nameStart - 1) : "",
    nameMatches: positions.filter((at) => at >= nameStart).map((at) => at - nameStart),
    // The slash between the folders and the name is not drawn.
    directoryMatches: positions.filter((at) => at < nameStart - 1),
  };
}

/**
 * The files that match `rawQuery`, best first, and how many matched. An empty
 * query lists the files in the store's order (sorted by path).
 */
export function rankQuickOpenFiles(
  candidates: QuickOpenCandidate[],
  rawQuery: string,
  limit = QUICK_OPEN_RESULT_LIMIT,
): { results: QuickOpenResult[]; total: number } {
  const pieces = prepareQuery(rawQuery);
  if (!pieces.length) {
    return {
      results: candidates.slice(0, limit).map((candidate) => toResult(candidate, [])),
      total: candidates.length,
    };
  }

  const preferName = !pieces.some((piece) => piece.text.includes("/"));
  // Spaces kept, as a file name may have them.
  const wholeQuery = foldCase(normalizeQueryText(rawQuery.trim()));
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    const match = scoreCandidate(pieces, candidate, preferName, wholeQuery);
    if (match) scored.push(match);
  }
  scored.sort(compareScored);
  return {
    results: scored
      .slice(0, limit)
      .map(({ candidate, positions }) => toResult(candidate, positions)),
    total: scored.length,
  };
}

/**
 * `text` cut into runs of matched and unmatched characters, for highlighting.
 * Positions are UTF-16 units; a character outside the BMP (an emoji) counts as
 * matched when either of its units did, so no run splits it in two.
 */
export function highlightRuns(
  text: string,
  matches: number[],
): Array<{ text: string; matched: boolean }> {
  const matched = new Set(matches);
  const runs: Array<{ text: string; matched: boolean }> = [];
  let index = 0;
  for (const character of text) {
    const isMatched = matched.has(index) || (character.length === 2 && matched.has(index + 1));
    index += character.length;
    const last = runs[runs.length - 1];
    if (last && last.matched === isMatched) last.text += character;
    else runs.push({ text: character, matched: isMatched });
  }
  return runs;
}
