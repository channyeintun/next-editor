import * as path from "node:path";
import * as fs from "node:fs";
import Mocha from "mocha";

function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (entry.name.endsWith(".test.js")) {
      out.push(full);
    }
  }
  return out;
}

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 60_000 });
  for (const file of collectTestFiles(__dirname)) {
    mocha.addFile(file);
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}
