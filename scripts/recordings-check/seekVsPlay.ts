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
import { countOdd, createCheck, tallyOf, untilStopped, type CheckResult } from "./check.ts";
import { openReplayPage, PAGE_TRACKS, type PageShown } from "./page.ts";
import { seededRandom, shuffled } from "./random.ts";
import { compare } from "./tally.ts";
import { checkTimes } from "./times.ts";

export const SEEK_VS_PLAY = "seek vs play";

export interface SeekVsPlayOptions {
  seed: number;
  /** The timeline's tick, in ms. */
  tickMs: number;
  /** The grid of check times, in ms, on top of every replayed stamp. */
  everyMs: number;
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

export function checkSeekVsPlay(recording: Recording, options: SeekVsPlayOptions): CheckResult {
  const result = createCheck(
    SEEK_VS_PLAY,
    PAGE_TRACKS.map((track) => ({ track, scope: "in law" as const })),
  );
  return untilStopped(result, () => {
    const checks = checkTimes(recording, options.everyMs);
    const isCheck = new Set(checks);

    const played = openReplayPage(recording);
    const playedAt = new Map<number, PageShown>();
    for (const time of tickTimes(recording.duration, options.tickMs, checks)) {
      played.send({ type: "TICK", currentTime: time });
      countOdd(result, played.errors);
      if (isCheck.has(time)) playedAt.set(time, structuredClone(played.shown()));
    }

    const seeked = openReplayPage(recording);
    countOdd(result, seeked.errors);
    for (const time of shuffled(checks, seededRandom(options.seed))) {
      seeked.send({ type: "SEEK", time });
      countOdd(result, seeked.errors);
      const shown = seeked.shown();
      const atTime = playedAt.get(time)!;
      for (const track of PAGE_TRACKS) {
        compare(tallyOf(result, track), time, atTime[track], shown[track]);
      }
    }
  });
}
