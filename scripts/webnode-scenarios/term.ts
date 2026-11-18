// The interactive shell on a terminal: prompt, echo, job control, Ctrl+C and
// Ctrl+D for built-ins and programs, pipelines, devices. Every step throws
// when it does not hold (scripts/webnode-scenario.ts), and every pattern is
// read after the echo of the line that was typed.
import type { HarnessApi } from "../webnode-harness";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A new prompt, with nothing but its own line before it. */
const PROMPT = /^[^\r\n]*❯/;

export default async function (api: HarnessApi) {
  await api.call("mount", {
    "upper.js": {
      file: {
        // Ends quietly when its reader has gone, as a filter does.
        contents: `process.stdout.on("error", () => process.exit(0));\nprocess.stdin.on("data", (d) => process.stdout.write(String(d).toUpperCase()));\n`,
      },
    },
  });
  const term = await api.terminal("jsh");
  await term.expect("prompt", /❯/);
  await term.run("echo", "echo hi there", /^hi there\r\n/);

  await term.run("a background job is announced", "sleep 30 &", /^\[1\] \d+\r\n/);
  await term.expect("and leaves the terminal to the shell", PROMPT);
  await term.run("typing still reaches the shell", "echo typed-$((1+1))", /^typed-2\r\n/);

  await term.enter("while :; do :; done");
  await pause(700);
  await term.keys("\x03");
  await term.expect("Ctrl+C stops a loop of builtins", /^\^C\r\n[^\r\n]*❯/);
  await term.run("with status 130", "echo stopped $?", /^stopped 130\r\n/);

  await term.enter("cat");
  await term.enter("line one");
  await term.expect("cat prints the line it read", /^line one\r\n/);
  await term.keys("\x04");
  await term.expect("Ctrl+D ends cat", PROMPT);
  await term.run("with status 0", "echo eof $?", /^eof 0\r\n/);

  await term.enter("cat");
  await pause(400);
  await term.keys("\x03");
  await term.expect("Ctrl+C ends cat reading the terminal", /^\^C\r\n[^\r\n]*❯/);
  await term.run("with status 130", "echo interrupted $?", /^interrupted 130\r\n/);
  await term.run("the next line is the shell's", "echo next-$((2+3))", /^next-5\r\n/);

  await term.enter("read answer");
  await pause(400);
  await term.keys("\x03");
  await term.expect("Ctrl+C ends read", /^\^C\r\n[^\r\n]*❯/);
  await term.run(
    "and the next line is the shell's",
    "echo after-read-$((3+4))",
    /^after-read-7\r\n/,
  );

  await term.run(
    "two pipelines in a row",
    "echo a1 | cat; echo b2 | cat; echo c3 | tr a-z A-Z",
    /^a1\r\nb2\r\nC3\r\n/,
  );
  await term.run(
    "a pipeline with an early reader",
    "while :; do echo y; done | head -2; echo head-done",
    /^y\r\ny\r\nhead-done\r\n/,
  );
  await term.run(
    "a built-in loop into a program into head",
    "while :; do echo y; done | node upper.js | head -2; echo upper-done",
    /^Y\r\nY\r\nupper-done\r\n/,
    15000,
  );
  await term.run(
    "a child shell whose reader has gone dies of SIGPIPE",
    "set -o pipefail; sh -c 'while :; do echo y; done' | head -1; echo piped $?; set +o pipefail",
    /^y\r\npiped 141\r\n/,
    15000,
  );

  await term.enter("cat | node upper.js");
  await term.enter("hello");
  await term.expect("a pipeline reads the terminal", /^HELLO\r\n/);
  await term.keys("\x03");
  await term.expect("Ctrl+C ends the pipeline", /^\^C\r\n[^\r\n]*❯/);
  await term.run("with status 130", "echo pipeline $?", /^pipeline 130\r\n/);

  await term.enter(`node -e "setInterval(()=>console.log('tick'),150)"`);
  await term.expect("a node process prints", /^tick\r\ntick\r\n/);
  await term.keys("\x03");
  await term.expect("Ctrl+C ends the foreground node", /\^C\r\n[^\r\n]*❯/);
  await term.run("with status 130", "echo after $?", /^after 130\r\n/);

  await term.enter(
    `node -e "process.stdin.once('data', d => { console.log('got ' + String(d).trim()); process.exit(0) })"`,
  );
  await pause(600);
  await term.enter("abc");
  await term.expect("a node process reads the terminal", /^got abc\r\n/);

  await term.run(
    "output to /dev/null and devices",
    "echo gone > /dev/null; echo shown > /dev/stdout; ls -l /dev/null | cut -c1",
    /^shown\r\nc\r\n/,
  );
  await term.run(
    "rm refuses the directory it is in",
    "mkdir -p /tmp/rmt && cd /tmp/rmt && rm -rf . ; echo rm $?; cd /",
    /rm 1\r\n/,
  );
  await term.run("kill the background job", "kill %1; wait %1; echo job $?", /job 143\r\n/);
  await term.enter("exit");
  await term.expectExit("exit ends the shell", 0);
}
