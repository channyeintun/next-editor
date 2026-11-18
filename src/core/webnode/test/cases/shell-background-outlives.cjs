// A background job the shell runs as a subshell, a group or an and-or list
// outlives the shell, as a forked subshell outlives its parent: the shell
// exits at once, and the job's output still reaches the pipe it inherited,
// which stays open until the job ends.
const { spawn, spawnSync, exec, execSync } = require("child_process");

const about = (start, step) => Math.round((Date.now() - start) / step) * step;
const forms = [
  "(sleep 1; echo late) & echo early",
  "sleep 1 && echo late & echo early",
  "{ sleep 1; echo late; } & echo early",
];

function runSync() {
  for (const form of forms) {
    const start = Date.now();
    const r = spawnSync("sh", ["-c", form], { encoding: "utf8" });
    console.log("spawnSync:", JSON.stringify(r.stdout), r.status, r.signal, about(start, 500));
  }
  {
    const start = Date.now();
    const r = spawnSync("sh", ["-c", "(sleep 1; echo late) & exit 3"], { encoding: "utf8" });
    console.log("exit 3:", JSON.stringify(r.stdout), r.status, r.signal, about(start, 500));
  }
  {
    const r = spawnSync("sh", ["-c", "(sleep 1; echo late) & kill -TERM $$"], {
      encoding: "utf8",
    });
    console.log("kill -TERM $$:", JSON.stringify(r.stdout), r.status, r.signal);
  }
  try {
    execSync("(sleep 1; echo late) & echo early", { encoding: "utf8", timeout: 400 });
    console.log("execSync timeout: returned");
  } catch (error) {
    console.log(
      "execSync timeout:",
      error.code,
      JSON.stringify(error.stdout),
      error.status,
      error.signal,
    );
  }
}

function runExec(done) {
  const start = Date.now();
  const events = [];
  const child = exec("(sleep 1; echo late) & echo early", (error, stdout) => {
    events.push(`callback ${error} ${JSON.stringify(stdout)} ${about(start, 500)}`);
  });
  child.on("exit", (code, signal) => events.push(`exit ${code} ${signal} ${about(start, 500)}`));
  child.on("close", (code) => {
    events.push(`close ${code} ${about(start, 500)}`);
    console.log("exec:", events.join(" | "));
    done();
  });
}

function runSpawn(done) {
  const start = Date.now();
  const child = spawn("sh", ["-c", "(sleep 1; echo late) & echo early"]);
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.on("exit", (code) => console.log("spawn exit:", code, about(start, 500)));
  child.stdout.on("end", () => {
    console.log("spawn stdout end:", JSON.stringify(out), about(start, 500));
    done();
  });
}

runSync();
runExec(() => runSpawn(() => setTimeout(() => console.log("done"), 1200)));
