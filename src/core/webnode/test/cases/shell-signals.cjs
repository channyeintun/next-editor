// Signals and a shell: one that its parent kills while its standard output
// is a pipe nobody reads, one that waits for the programs of a pipeline, one
// whose reader has gone (SIGPIPE), and one that sends itself a signal. Each
// line must end under webnode's sh as it does under the real /bin/sh.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");

fs.writeFileSync("big.txt", "0123456789\n".repeat(30000));
// Runs until a signal ends it, or two seconds have passed.
fs.writeFileSync("stay.js", "console.error('up'); setTimeout(() => {}, 2000);\n");
// Shuts down on SIGTERM or SIGUSR2, as a server does: it exits 0 a little later.
fs.writeFileSync(
  "graceful.js",
  "for (const signal of ['SIGTERM', 'SIGUSR2']) process.on(signal, () => setTimeout(() => process.exit(0), 100));\n" +
    "console.error('up'); setTimeout(() => process.exit(9), 1500);\n",
);
fs.writeFileSync(
  "count.sh",
  "i=0\nwhile [ $i -lt 100000 ]; do echo line $i; i=$((i+1)); done\necho finished >&2\n",
);

/**
 * How `sh -c line` ends when `signal` is sent to it once `ready` says so:
 * "promptly", or "late" when it took more than a second from the signal.
 */
function killed(line, signal, stdio, ready) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", line], { stdio });
    let sent = Infinity;
    let stderr = "";
    const send = () =>
      setTimeout(() => {
        sent = Date.now();
        child.kill(signal);
      }, 300);
    if (ready) {
      child.stderr.on("data", (chunk) => {
        const before = stderr;
        stderr += chunk;
        if (!ready(before) && ready(stderr)) {
          send();
        }
      });
    } else {
      send();
    }
    child.on("exit", (code, ended) => {
      const prompt = Date.now() - sent < 1000 ? "promptly" : "late";
      console.log(JSON.stringify([line, signal, code, ended, prompt]));
      resolve();
    });
  });
}

/** The shell's standard output is a pipe that is never read. */
const unread = ["ignore", "pipe", "inherit"];
/** Nothing is piped but standard error, which says when the programs are up. */
const quiet = ["ignore", "ignore", "pipe"];
const up = (count) => (text) => (text.match(/up/g) ?? []).length >= count;

async function main() {
  // A pipeline that ends in a built-in filter, blocked on its output.
  await killed("seq 1 100000 | cat", "SIGTERM", unread);
  await killed("cat big.txt | cat | cat", "SIGTERM", unread);
  await killed("seq 1 100000 | cat; echo after >&2", "SIGHUP", unread);
  await killed('x=$(seq 1 100000 | cat); echo "$x" | cat', "SIGTERM", unread);
  // A shell that waits for programs: it ends at once, whatever they do.
  await killed("node stay.js | node stay.js", "SIGTERM", quiet, up(2));
  await killed("node stay.js | node stay.js", "SIGHUP", quiet, up(2));
  await killed("node stay.js | cat", "SIGTERM", quiet, up(1));
  await killed("sleep 4 | node stay.js", "SIGTERM", quiet, up(1));
  await killed("node stay.js; echo next >&2", "SIGTERM", quiet, up(1));
  await killed("node stay.js && node stay.js", "SIGTERM", quiet, up(1));
  await killed("exec sleep 100", "SIGTERM", quiet);
  await killed("sleep 100", "SIGTERM", quiet);
  // The lone command of `sh -c`, and `exec`: the shell is that program,
  // which gets every signal sent to the shell and decides how it ends.
  await killed("node graceful.js", "SIGTERM", quiet, up(1));
  await killed("exec node graceful.js", "SIGTERM", quiet, up(1));
  await killed("node graceful.js", "SIGUSR2", quiet, up(1));
  await killed("node stay.js", "SIGUSR2", quiet, up(1));
  // With more to do the shell is not its program: the signal ends it.
  await killed("node graceful.js; echo next >&2", "SIGTERM", quiet, up(1));

  const lines = [
    // A shell whose reader has gone dies of SIGPIPE at its next write.
    "sh -c 'while :; do echo y; done' | head -n 1; echo \"st=$?\"",
    "sh -c 'f() { while :; do printf \"%s\\n\" tick; done; }; f' | sed 1q",
    "set -o pipefail; sh -c 'while :; do echo y; done' | head -n 1; echo \"st=$?\"",
    'sh count.sh | head -n 1; echo "st=$?"',
    'set -o pipefail; sh -c \'(while :; do echo y; done); echo "sub=$?" >&2; exit 0\' | head -n 1; echo "st=$?"',
    'set -o pipefail; sh -c \'seq 1 100000; echo "seq=$?" >&2; exit 0\' | head -n 1; echo "st=$?"',
    // A signal a shell sends itself is delivered before the next command.
    "kill -TERM $$; echo after",
    "kill -TERM $$",
    "kill -INT $$; echo after",
    "kill -HUP $$; echo after",
    "kill -PIPE $$; echo after",
    "die() { kill -s TERM $$; }; f() { die; echo in-f; }; f; echo after",
    "trap 'echo T' TERM; kill -TERM $$; echo after",
    "trap 'echo got' USR1; kill -USR1 $$; echo next",
    "trap 'echo cleanup; trap - INT; kill -INT $$' INT; kill -INT $$; echo not-reached",
    // Its EXIT trap runs first, whichever signal ends it.
    "trap 'echo exit-trap' EXIT; kill -TERM $$; echo not-reached",
    "trap 'echo exit-trap; echo twice' EXIT; kill -USR1 $$; echo not-reached",
    "kill -USR1 $$; echo after",
    "kill -CONT $$; kill -WINCH $$; echo alive",
  ];
  for (const line of lines) {
    const result = spawnSync("sh", ["-c", line], { encoding: "utf8" });
    console.log(JSON.stringify([line, result.status, result.signal, result.stdout, result.stderr]));
  }
}

main();
