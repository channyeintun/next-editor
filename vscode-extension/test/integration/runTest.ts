import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // dist-test/runTest.js -> extension root is one level up.
  const extensionDevelopmentPath = path.resolve(__dirname, "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");
  const cachePath = path.join(extensionDevelopmentPath, ".test-vscode");

  // A disposable multi-root workspace (plan §15 Phase 5: exercise
  // multi-root scenarios) keeps integration runs deterministic.
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "next-recording-itest-"));
  fs.mkdirSync(path.join(workspacePath, "root-a"));
  fs.mkdirSync(path.join(workspacePath, "root-b"));
  const workspaceFile = path.join(workspacePath, "itest.code-workspace");
  fs.writeFileSync(
    workspaceFile,
    JSON.stringify({ folders: [{ path: "root-a" }, { path: "root-b" }] }),
  );

  try {
    await runTests({
      cachePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspaceFile,
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
