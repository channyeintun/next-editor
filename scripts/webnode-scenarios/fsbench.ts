// Filesystem calls from a process, timed. The run fails when the benchmark
// does not finish or a call costs more than its ceiling: several times what
// it measures on this machine (in the comments), so that load does not fail
// it and a filesystem that fell back to asking the kernel does.
import { readFileSync } from "node:fs";
import type { HarnessApi } from "../webnode-harness";
import { plainText as strip } from "./text";

const source = readFileSync(new URL("./fsbench.cjs", import.meta.url), "utf8");

/** Microseconds a call. WEBNODE_HARNESS_FS=kernel runs the filesystem inside the kernel worker. */
const CEILINGS: Record<string, number> =
  process.env.WEBNODE_HARNESS_FS === "kernel"
    ? {
        "statSync (exists)": 100, // 19.5
        "existsSync (missing)": 100, // 21.4
        "readFileSync 40 B": 80, // 15.5
        "readFileSync 200 KB": 350, // 70.3
        readdirSync: 85, // 17.1
      }
    : {
        "statSync (exists)": 5, // 0.8
        "existsSync (missing)": 5, // 0.9
        "readFileSync 40 B": 5, // 0.9
        "readFileSync 200 KB": 150, // 23 to 31
        readdirSync: 6, // 1.1
      };

export default async function (api: HarnessApi) {
  await api.call("mount", { "fsbench.cjs": { file: { contents: source } } });
  const best = new Map<string, number>();
  for (let run = 1; run <= 2; run += 1) {
    const result = await api.sh("node fsbench.cjs", { timeoutMs: 120000 });
    const output = strip(result.output).trim();
    console.log(`run ${run}\n${output}`);
    const rows = [...output.matchAll(/^(.+?) +\d+ calls +\d+ ms +([\d.]+) us\/call$/gm)];
    api.check(
      `run ${run} finishes with a row for every call`,
      result.code === 0 && rows.map((row) => row[1]).join("|") === Object.keys(CEILINGS).join("|"),
      `exit ${result.code}${result.timedOut ? ", timed out" : ""}: ${JSON.stringify(output.slice(-600))}`,
    );
    for (const [, label, cost] of rows) {
      best.set(label, Math.min(best.get(label) ?? Infinity, Number(cost)));
    }
  }
  for (const [label, ceiling] of Object.entries(CEILINGS)) {
    const cost = best.get(label) ?? Infinity;
    api.check(`${label}: ${cost} us a call, at most ${ceiling}`, cost <= ceiling);
  }
}
