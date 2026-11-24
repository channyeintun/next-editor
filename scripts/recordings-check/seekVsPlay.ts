/**
 * Seeking lands where playing does, while replay owns the page.
 *
 * One page plays the recording tick by tick; another seeks to the same times in a
 * shuffled order. At every check time each panel must show the same on both. Both
 * read the same bytes, so this cannot see a defect a file was captured with: only
 * one in how replay gets to a time.
 *
 * The editor handshake (SET_EDITOR_REF) arrives right after the move that asked for
 * it. In the app it arrives a render later; that delay is walked by the generated
 * frames property in src/core/src/machine/replayState/pathIndependence.test.ts.
 */

import type { Recording } from "../../src/core/src";
import {
  countErrors,
  createCheck,
  isCompared,
  markNoEvents,
  tallyOf,
  untilStopped,
  type CheckResult,
} from "./check.ts";
import {
  openReplayPage,
  PAGE_TRACKS,
  type PageShown,
  type PageTrack,
  type ReplayPage,
} from "./page.ts";
import { seededRandom, shuffled } from "./random.ts";
import { differenceAt, digestOf } from "./tally.ts";
import { checkTimes, panelHasEvents } from "./times.ts";

export const SEEK_VS_PLAY = "seek vs play";

export interface SeekVsPlayOptions {
  seed: number;
  /** The timeline's tick, in ms. */
  tickMs: number;
  /** The grid of check times, in ms, on top of every replayed stamp. */
  everyMs: number;
  /** Opens each page; the real replay page unless a test hands in a broken one. */
  openPage?: (recording: Recording) => ReplayPage;
}

export const DEFAULT_SEEK_VS_PLAY: Omit<SeekVsPlayOptions, "seed"> = {
  tickMs: 1000 / 60,
  everyMs: 250,
};

/** Tick times: the tick grid with every check time merged in, sorted. */
function tickTimes(duration: number, tickMs: number, checks: readonly number[]): number[] {
  const times = new Set(checks);
  for (let time = 0; time <= duration; time += tickMs) times.add(time);
  return [...times].sort((left, right) => left - right);
}

/**
 * Plays `recording` tick by tick on a new page and hands `atCheck` what the page
 * shows at each check time, until `until`. Errors the page reports go to `onErrors`.
 */
function play(
  open: (recording: Recording) => ReplayPage,
  recording: Recording,
  ticks: readonly number[],
  isCheck: ReadonlySet<number>,
  until: number,
  atCheck: (time: number, shown: PageShown) => void,
  onErrors: (errors: string[]) => void,
): void {
  const played = open(recording);
  for (const time of ticks) {
    if (time > until) return;
    played.send({ type: "TICK", currentTime: time });
    onErrors(played.errors);
    if (isCheck.has(time)) atCheck(time, played.shown());
  }
}

export function checkSeekVsPlay(recording: Recording, options: SeekVsPlayOptions): CheckResult {
  const result = createCheck(
    SEEK_VS_PLAY,
    PAGE_TRACKS.map((track) => ({ track, scope: "in law" as const })),
  );
  for (const track of PAGE_TRACKS) {
    if (!panelHasEvents(recording, track)) markNoEvents(result, track);
  }
  const compared = PAGE_TRACKS.filter((track) => isCompared(result, track));
  const open = options.openPage ?? openReplayPage;
  return untilStopped(result, () => {
    const checks = checkTimes(recording, options.everyMs);
    const isCheck = new Set(checks);
    const ticks = tickTimes(recording.duration, options.tickMs, checks);

    // A digest per track per time, not a copy of the page: the first difference of
    // each track is described after the seeks, from one more walk to its time.
    const playedAt = new Map<number, Map<PageTrack, string>>();
    play(
      open,
      recording,
      ticks,
      isCheck,
      Infinity,
      (time, shown) =>
        playedAt.set(time, new Map(compared.map((track) => [track, digestOf(shown[track])]))),
      (errors) => countErrors(result, errors),
    );

    const firstSeeked = new Map<PageTrack, { time: number; shown: unknown }>();
    const seeked = open(recording);
    countErrors(result, seeked.errors);
    for (const time of shuffled(checks, seededRandom(options.seed))) {
      seeked.send({ type: "SEEK", time });
      countErrors(result, seeked.errors);
      const shown = seeked.shown();
      const atTime = playedAt.get(time)!;
      for (const track of compared) {
        const tally = tallyOf(result, track);
        tally.checks += 1;
        if (digestOf(shown[track]) === atTime.get(track)) continue;
        tally.diffs += 1;
        if (!firstSeeked.has(track)) {
          firstSeeked.set(track, { time, shown: structuredClone(shown[track]) });
        }
      }
    }
    if (firstSeeked.size === 0) return;

    const wanted = new Set([...firstSeeked.values()].map(({ time }) => time));
    play(
      open,
      recording,
      ticks,
      wanted,
      Math.max(...wanted),
      (time, shown) => {
        for (const [track, first] of firstSeeked) {
          if (first.time !== time) continue;
          tallyOf(result, track).first = differenceAt(time, shown[track], first.shown) ?? {
            time,
            path: "",
            a: "(equal on a second walk)",
            b: "(digests differed)",
          };
        }
      },
      () => {},
    );
  });
}
