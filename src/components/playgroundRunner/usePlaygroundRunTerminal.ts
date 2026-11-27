import { useRef, useState } from "react";
import { splitOutputLines } from "../../runtime/playgroundConsole";
import {
  openRunnerConsoleStream,
  type RunnerConsoleStream,
} from "../../runtime/playgroundConsoleStore";
import type { PlaygroundRunTerminal } from "../../runtime/playgroundLanguage";
import type { RuntimePanelStoreInstance } from "../../stores/runtimePanelStore";

/**
 * The runner dock as a terminal, for a language whose run is interactive
 * (PlaygroundRun.interactive): what the program prints goes to the console as
 * it arrives, and while the program waits for a line the dock shows its input
 * row and hands over what the learner types there.
 *
 * One run holds the terminal at a time. A run that was replaced or has ended
 * can no longer print or ask, so a late message from it never lands in a newer
 * run's console.
 */
export function usePlaygroundRunTerminal(runtimePanelStore: RuntimePanelStoreInstance) {
  /** The console lines of the run that holds the terminal; null between runs. */
  const streamRef = useRef<RunnerConsoleStream | null>(null);
  /** Hands the waiting program its line; null while no program waits for one. */
  const [answerLine, setAnswerLine] = useState<((line: string | null) => void) | null>(null);

  /** Ends the current run's hold on the terminal, giving back its console stream. */
  const release = (): RunnerConsoleStream | null => {
    const stream = streamRef.current;
    streamRef.current = null;
    setAnswerLine(null);
    return stream;
  };

  return {
    /** Whether a program asked for a line it has not been given. */
    isWaitingForLine: answerLine !== null,

    /**
     * The terminal for a run that starts now, after its started lines are in
     * the console. It takes the terminal from whichever run held it.
     */
    open(): PlaygroundRunTerminal {
      release();
      const stream = openRunnerConsoleStream(runtimePanelStore);
      streamRef.current = stream;
      const holdsTerminal = () => streamRef.current === stream;
      return {
        print: (output) => {
          if (holdsTerminal()) stream.show(splitOutputLines(output));
        },
        readLine: () =>
          new Promise((resolve) => {
            // A function in state is set through an updater, or React calls it.
            if (holdsTerminal()) setAnswerLine(() => resolve);
          }),
      };
    },

    /** The learner's line, for the program that waits for one; null ends its input. */
    submitLine(line: string | null): void {
      answerLine?.(line);
      setAnswerLine(null);
    },

    /**
     * Ends the run on the terminal with the lines of its result, which take
     * the place of the output shown while it ran: they begin with that output.
     * False when no run held the terminal, so nothing of the result is in the
     * console yet.
     */
    finish(lines: readonly string[]): boolean {
      const stream = release();
      stream?.show(lines);
      return stream !== null;
    },

    /** Ends the run on the terminal with nothing more to show. */
    close(): void {
      release();
    },
  };
}
