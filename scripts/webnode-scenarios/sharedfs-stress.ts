// The shared filesystem between processes and the page: a watcher in one
// process sees another's writes, the page reads what a process wrote, and the
// filesystem still answers after many processes were killed in the middle of
// their calls. Every step throws when it does not hold.
import type { HarnessApi } from "../webnode-harness";
import { plainText as strip } from "./text";

export default async function (api: HarnessApi) {
  await api.call("mount", {
    "watch.cjs": {
      file: {
        contents: `
const fs = require("fs");
const { spawn } = require("child_process");
fs.mkdirSync("watched", { recursive: true });
const seen = new Set();
const watcher = fs.watch("watched", (type, name) => {
  seen.add(name);
  if (seen.has("a.txt") && seen.has("b.txt")) {
    console.log("watcher saw:", [...seen].sort().join(","));
    watcher.close();
  }
});
spawn("node", ["-e", "const fs=require('fs');fs.writeFileSync('watched/a.txt','1');fs.writeFileSync('watched/b.txt','2');"], { stdio: "inherit" });
setTimeout(() => { console.log("TIMEOUT, saw only:", [...seen].join(",")); process.exit(1); }, 8000).unref();
`,
      },
    },
    "spin.cjs": {
      file: {
        contents: `
const fs = require("fs");
fs.mkdirSync("spin", { recursive: true });
let n = 0;
console.log("spinning");
for (;;) {
  fs.writeFileSync("spin/f" + (n % 50), "x".repeat(n % 4096));
  fs.statSync("spin/f" + (n % 50));
  fs.readdirSync("spin");
  if (n % 7 === 0) fs.rmSync("spin/f" + (n % 50), { force: true });
  n++;
}
`,
      },
    },
  });
  const sh = async (line: string, timeoutMs: number) => {
    const result = await api.sh(line, { timeoutMs });
    return { ...result, text: strip(result.output).trim() };
  };

  // 1. A watcher in one process sees a write made by another process directly.
  let r = await sh("node watch.cjs", 20000);
  api.check(
    "a watcher in one process sees another process's writes",
    r.code === 0 && r.text === "watcher saw: a.txt,b.txt",
    `exit ${r.code}${r.timedOut ? ", timed out" : ""}: ${JSON.stringify(r.text)}`,
  );

  // 2. What a process wrote is there for another process and for the page.
  r = await sh(
    "node -e \"require('fs').writeFileSync('from-process.txt','hello')\" && cat from-process.txt",
    20000,
  );
  api.check(
    "a process reads what another process wrote",
    r.code === 0 && r.text === "hello",
    `exit ${r.code}: ${JSON.stringify(r.text)}`,
  );
  const fromPage = await api.call<string>("readFile", "from-process.txt");
  api.check("the page reads the same file", fromPage === "hello", JSON.stringify(fromPage));

  // 3. Kill processes that are hammering the filesystem, many times over.
  const rounds = Number(process.env.KILL_ROUNDS ?? 60);
  let started = 0;
  const begin = Date.now();
  for (let round = 0; round < rounds; round += 1) {
    const ids: number[] = [];
    for (let k = 0; k < 3; k += 1) {
      ids.push(await api.call<number>("start", "node", ["spin.cjs"]));
    }
    for (const id of ids) {
      // waitFor answers false at its timeout: it never throws.
      if (!(await api.call<boolean>("waitFor", id, "spinning", 15000))) {
        const state = await api.call<{ output: string; exited: number | null }>("read", id);
        throw new Error(
          `round ${round}: a spinning process did not start (exited ${state.exited}): ${JSON.stringify(state.output.slice(-300))}`,
        );
      }
    }
    started += ids.length;
    // Let them run a moment so some are inside a call when they are killed.
    await new Promise((resolve) => setTimeout(resolve, 15 + (round % 5) * 10));
    for (const id of ids) {
      await api.call("kill", id);
    }
    const deadline = Date.now() + 5000;
    for (const id of ids) {
      while ((await api.call<{ exited: number | null }>("read", id)).exited === null) {
        if (Date.now() > deadline) {
          throw new Error(`round ${round}: a killed process is still running after 5 s`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
  api.check(
    `started and killed ${started} spinning processes (${Date.now() - begin} ms)`,
    started === rounds * 3,
  );

  // The filesystem must still answer, promptly, from a new process and from the page.
  const t = Date.now();
  r = await sh(
    "node -e \"const fs=require('fs');fs.writeFileSync('after.txt','ok');console.log(fs.readFileSync('after.txt','utf8'), fs.readdirSync('.').includes('after.txt'))\"",
    15000,
  );
  api.check(
    `a new process writes and reads after the kills (${Date.now() - t} ms)`,
    r.code === 0 && r.text === "ok true",
    `exit ${r.code}${r.timedOut ? ", timed out" : ""}: ${JSON.stringify(r.text)}`,
  );
  const entries = await api.call<string[]>("readdir", ".");
  api.check(
    "the page lists the directory, the new file in it",
    entries.includes("after.txt") && entries.includes("spin") && entries.includes("watched"),
    JSON.stringify(entries),
  );
}
