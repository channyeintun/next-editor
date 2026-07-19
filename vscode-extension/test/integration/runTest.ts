import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // dist-test/runTest.js -> extension root is one level up.
  const extensionDevelopmentPath = path.resolve(__dirname, "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");
  const cachePath = path.join(extensionDevelopmentPath, ".test-vscode");

  // A disposable workspace keeps integration runs deterministic.
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "next-recording-itest-"));

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
  console.error("Integration tests failed");
  console.error(error);
  process.exit(1);
});
