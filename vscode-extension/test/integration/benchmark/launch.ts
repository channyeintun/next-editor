import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "index.js");
  const cachePath = path.join(extensionDevelopmentPath, ".test-vscode");
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "next-recording-bench-"));

  try {
    await runTests({
      cachePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
      ],
    });
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Benchmark run failed");
  console.error(error);
  process.exit(1);
});
