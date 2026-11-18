// Resizing the terminal: a program on it sees the new size, its stdout emits
// 'resize' and the process gets SIGWINCH, when the size changes and only then.
// The same steps run first on a real pty under real node (term-resize-pty.py),
// and what webnode's terminal prints must be the same, byte for byte.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessApi } from "../webnode-harness";

type Step = { expect: string } | { type: string } | { resize: [number, number] };

/** Reports the terminal's size at its start and whenever it changes; answers `ping`; ends on `quit`. */
const SIZE_CJS = `const report = (what) =>
  console.log(what + " " + process.stdout.columns + "x" + process.stdout.rows +
    " stdin=" + process.stdin.isTTY + " stdout=" + process.stdout.isTTY +
    " getWindowSize=" + process.stdout.getWindowSize().join("x"));
report("start");
process.stdout.on("resize", () => report("resize"));
process.on("SIGWINCH", () => console.log("SIGWINCH"));
process.stdin.on("data", (data) => {
  const line = String(data).trim();
  if (line === "ping") console.log("pong");
  if (line === "quit") process.exit(0);
});
`;

const START: [number, number] = [100, 30];
/** What the program prints for a change of size: the event of its stdout, then the signal. */
const resized = (size: string) => String.raw`resize ${size} [^\r\n]*\r\nSIGWINCH\r\n`;
// Each step that types waits first for what the program prints before it:
// what is typed is echoed at once, in between whatever is still to come.
const STEPS: Step[] = [
  { expect: String.raw`start 100x30 [^\r\n]*\r\n` },
  { resize: [120, 40] },
  { expect: resized("120x40") },
  { type: "ping\r" },
  { expect: String.raw`pong\r\n` },
  // The same size again changes nothing: no signal, no event.
  { resize: [120, 40] },
  { type: "ping\r" },
  { expect: String.raw`pong\r\n` },
  { resize: [80, 24] },
  { expect: resized("80x24") },
  // Only one of the two changes.
  { resize: [80, 50] },
  { expect: resized("80x50") },
  { type: "ping\r" },
  { expect: String.raw`pong\r\n` },
  { type: "quit\r" },
];

const COMMANDS: { label: string; command: string; args: string[]; ends: string | null }[] = [
  { label: "a program on the terminal", command: "node", args: ["size.cjs"], ends: null },
  {
    label: "a program a shell runs in the foreground",
    command: "sh",
    args: ["-c", "node size.cjs; echo ended $?"],
    ends: String.raw`ended 0\r\n`,
  },
];

/** What real node prints for the steps on a real pty. */
function reference(command: string, args: string[], steps: Step[]): string {
  const sandbox = mkdtempSync(resolve(tmpdir(), "webnode-resize-"));
  writeFileSync(resolve(sandbox, "size.cjs"), SIZE_CJS);
  const driver = fileURLToPath(new URL("./term-resize-pty.py", import.meta.url));
  const run = spawnSync(
    "python3",
    [driver, JSON.stringify(steps), String(START[0]), String(START[1]), sandbox, command, ...args],
    { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  rmSync(sandbox, { recursive: true, force: true });
  if (run.status !== 0) {
    throw new Error(
      `the reference run failed (${run.status}): ${run.stderr}\n${JSON.stringify(run.stdout)}`,
    );
  }
  return run.stdout;
}

export default async function (api: HarnessApi) {
  await api.call("mount", { "size.cjs": { file: { contents: SIZE_CJS } } });
  for (const { label, command, args, ends } of COMMANDS) {
    await api.section(label, async () => {
      const steps = ends === null ? STEPS : [...STEPS, { expect: ends }];
      const expected = reference(command, args, steps);
      console.log(`     real node on a pty printed ${JSON.stringify(expected)}`);
      const term = await api.terminal(command, args, {
        env: { NO_COLOR: "1" },
        size: { cols: START[0], rows: START[1] },
      });
      for (const step of steps) {
        if ("expect" in step) {
          await term.expect(`prints ${step.expect}`, new RegExp(step.expect));
        } else if ("type" in step) {
          await term.keys(step.type);
        } else {
          await term.resize(...step.resize);
        }
      }
      await term.expectExit("the program ends", 0);
      const printed = await term.output();
      api.check(
        "webnode's terminal printed what the real one did",
        printed === expected,
        `webnode: ${JSON.stringify(printed)}\n   node:    ${JSON.stringify(expected)}`,
      );
    });
  }
}
