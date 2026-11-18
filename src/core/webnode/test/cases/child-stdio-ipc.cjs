// Children among themselves and with their parent: one child's output given
// to another as its stdin, a forked child's last messages and its exit, a
// detached child's process group, and the limits of exec and execSync.
const { exec, execSync, fork, spawn, spawnSync } = require("child_process");

if (process.argv[2] === "sender") {
  // Three messages, then the end: by exiting, or by disconnecting.
  process.send("m1");
  process.send("m2");
  if (process.argv[3] === "disconnect") {
    process.send("m3", () => process.disconnect());
  } else {
    process.send("m3", () => process.exit(0));
  }
  return;
}

const counter =
  "let n = 0; process.stdin.on('data', (d) => (n += String(d).split('\\n').length - 1)).on('end', () => console.log('lines read:', n))";

/** `first | second`, built by giving the first child's stdout to the second as its stdin. */
function pipeline(label, lines) {
  return new Promise((resolve) => {
    const first = spawn(
      "node",
      ["-e", `for (let i = 0; i < ${lines}; i++) console.log('line ' + i)`],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const second = spawn("node", ["-e", counter], { stdio: [first.stdout, "pipe", "inherit"] });
    // The stream is the second child's to read now: this process stopped.
    const state = `paused ${first.stdout.isPaused()}, flowing ${first.stdout.readableFlowing}`;
    let firstClosed = false;
    first.on("close", () => (firstClosed = true));
    let out = "";
    second.stdout.on("data", (chunk) => (out += chunk));
    second.on("close", (code) => {
      console.log(
        `${label}: ${out.trim()} of ${lines}, exit ${code}; the stream given away: ${state},`,
        `still holding ${first.stdout.readableLength}, first child's 'close' emitted: ${firstClosed}`,
      );
      resolve();
    });
  });
}

/** Forks a sender; `slow` makes each message's handler leave work behind, as an async consumer does. */
function messages(mode, slow) {
  return new Promise((resolve) => {
    const events = [];
    const child = fork(__filename, ["sender", mode]);
    child.on("message", (message) => {
      events.push(message);
      if (slow) {
        (async () => {
          for await (const part of require("stream").Readable.from([message])) {
            void part;
          }
        })();
      }
    });
    child.on("disconnect", () => events.push("disconnect"));
    child.on("exit", (code) => events.push(`exit ${code}`));
    child.on("close", () => {
      console.log(
        `a child that ends by ${mode}${slow ? ", slow handlers" : ""}: ${events.join(" ")}`,
      );
      resolve();
    });
  });
}

/** A detached child leads a process group: a negative pid reaches it and what it started. */
function group() {
  return new Promise((resolve) => {
    const stay = "node -e 'setInterval(() => {}, 1000)'";
    const beside = spawn("node", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const leader = spawn("sh", ["-c", `${stay} & ${stay}; wait`], {
      detached: true,
      stdio: "ignore",
    });
    const started = Date.now();
    setTimeout(() => {
      const attempt = (pid) => {
        try {
          return `sent ${process.kill(pid, "SIGTERM")}`;
        } catch (error) {
          return `${error.message}`;
        }
      };
      console.log("kill(-pid) of a child that is not detached:", attempt(-beside.pid));
      console.log("kill(-pid) of a detached child:", attempt(-leader.pid));
      beside.kill();
    }, 600);
    leader.on("exit", (code, signal) => {
      console.log(
        "the detached child:",
        code,
        signal,
        Date.now() - started < 3000 ? "promptly" : "late",
      );
      resolve();
    });
  });
}

function limits() {
  return new Promise((resolve) => {
    const writer = (stream, count) =>
      `node -e "process.${stream}.write('x'.repeat(${count})); setTimeout(() => {}, 5000)"`;
    try {
      execSync(writer("stdout", 1200000));
      console.log("execSync returned");
    } catch (error) {
      console.log(
        "execSync past the default maxBuffer:",
        error.code,
        error.status,
        error.signal,
        error.stdout.length >= 1024 * 1024,
      );
    }
    exec(writer("stdout", 3000), { maxBuffer: 1000 }, (error, stdout) => {
      console.log(
        "exec past maxBuffer:",
        error.constructor.name,
        error.code,
        Object.keys(error).join(","),
        stdout.length,
      );
      exec(writer("stderr", 10), { timeout: 300 }, (failure, out, err) => {
        console.log(
          "exec past its timeout:",
          Object.keys(failure).join(","),
          failure.code,
          failure.killed,
          failure.signal,
          JSON.stringify(err),
        );
        resolve();
      });
    });
  });
}

/** With no stdio option execSync captures stderr and passes it on to the parent's. */
function stderrOfExecSync() {
  const program = [
    "const { execSync } = require('child_process');",
    "try { execSync('echo out; echo err >&2; exit 2'); } catch (e) {",
    "  console.log(JSON.stringify([e.message, String(e.stdout), String(e.stderr), e.status]));",
    "}",
    "console.log(JSON.stringify(String(execSync('echo fine; echo warned >&2'))));",
  ].join("\n");
  const result = spawnSync("node", ["-e", program], { encoding: "utf8" });
  console.log("execSync, no stdio option:", result.stdout.trim().split("\n").join(" "));
  console.log("passed on to its stderr:", JSON.stringify(result.stderr));
}

(async () => {
  await pipeline("100 lines", 100);
  await pipeline("1 MB", 100000);
  await messages("exit", false);
  await messages("exit", true);
  await messages("exit", true);
  await messages("disconnect", true);
  await group();
  await limits();
  stderrOfExecSync();
})();
