// Watch mode as Node runs it. `node --watch-path` reruns its program after a
// change under the path and says how each run ended; `node --watch` reruns it
// only for the files the program loaded, and for a script that is not there
// yet, once it is created. Signalled, the supervisor ends with its child's
// exit code.
const { spawn } = require("child_process");
const fs = require("fs");

function supervise(args, steps, done, errorLine = null) {
  const supervisor = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  let output = "";
  let errors = "";
  let next = 0;
  const advance = () => {
    // Each step waits for its text to appear `times` times, then a moment more.
    while (next < steps.length && output.split(steps[next].after).length > steps[next].times) {
      setTimeout(steps[next].act, 300);
      next += 1;
    }
  };
  supervisor.stdout.on("data", (chunk) => {
    output += chunk;
    advance();
  });
  supervisor.stderr.on("data", (chunk) => {
    // With `errorLine`, only that line of standard error is shown: the stack
    // around it is the loader's own.
    if (errorLine === null) {
      output += chunk;
    } else {
      errors += chunk;
    }
  });
  supervisor.on("exit", (code, signal) => {
    const show = (text) => text.split(process.cwd()).join("<cwd>").trimEnd();
    console.log(show(output));
    if (errorLine !== null) {
      console.log(
        show(errors)
          .split("\n")
          .filter((line) => errorLine.test(line)),
      );
    }
    console.log("supervisor exit", code, signal);
    done();
  });
  return supervisor;
}

fs.mkdirSync("watched");
fs.writeFileSync("watched/data.txt", "one");
fs.writeFileSync(
  "run.js",
  "const d = require('fs').readFileSync('watched/data.txt', 'utf8'); console.log('run', d); process.exitCode = d === 'two' ? 3 : 0;",
);
fs.writeFileSync("lib.js", "module.exports = 'lib-1';");
fs.writeFileSync("other.txt", "unrelated");
fs.writeFileSync(
  "app.js",
  "console.log('app', require('./lib'), process.env.WATCH_REPORT_DEPENDENCIES);",
);

const byPath = supervise(
  ["--watch-path=watched", "run.js"],
  [
    {
      after: "Completed running",
      times: 1,
      act: () => fs.writeFileSync("watched/data.txt", "two"),
    },
    { after: "Failed running", times: 1, act: () => byPath.kill("SIGTERM") },
  ],
  () => {
    const byImports = supervise(
      ["--watch", "app.js"],
      [
        {
          after: "Completed running",
          times: 1,
          act: () => {
            fs.writeFileSync("other.txt", "changed");
            setTimeout(() => fs.writeFileSync("lib.js", "module.exports = 'lib-2';"), 700);
          },
        },
        { after: "Completed running", times: 2, act: () => byImports.kill("SIGINT") },
      ],
      () => {
        // The script is not there: the failed run is reported, and creating
        // the file runs it.
        const byCreation = supervise(
          ["--watch", "later.js"],
          [
            {
              after: "Failed running",
              times: 1,
              act: () => fs.writeFileSync("later.js", "console.log('later, here');"),
            },
            { after: "Completed running", times: 1, act: () => byCreation.kill("SIGINT") },
          ],
          () => {},
          /^Error: Cannot find module/,
        );
      },
    );
  },
);
