import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

type StartResult = { ok: boolean; sessionId?: string; code?: string };
type StopResult = {
  ok: boolean;
  code?: string;
  sessionId?: string;
  eventCount?: number;
  durationUs?: number;
  patches?: number;
  shadowMismatches?: number;
  sessionDir?: string;
};
type RecorderState = {
  state: string;
  sessionId: string | null;
  sessionDir: string | null;
  lastError: string | null;
};
type ScanEntry = {
  sessionId: string;
  state: string | null;
  recoverable: boolean;
  sessionDir: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function closeAllEditorsDiscardingChanges(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const hasTabs = vscode.window.tabGroups.all.some((group) => group.tabs.length > 0);
    if (!hasTabs) {
      return;
    }
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await sleep(20);
  }
}

function rootPath(index: number): string {
  const folder = vscode.workspace.workspaceFolders?.[index];
  assert.ok(folder, `workspace root ${index} missing`);
  return folder.uri.fsPath;
}

function createFile(root: string, name: string, content: string): vscode.Uri {
  const file = path.join(root, name);
  fs.writeFileSync(file, content, "utf8");
  return vscode.Uri.file(file);
}

async function recorderState(): Promise<RecorderState> {
  return (await vscode.commands.executeCommand("nextRecording.dev.recorderState")) as RecorderState;
}

suite("native recording lifecycle", function () {
  this.timeout(120_000);

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension("channyeintun.next-recording");
    assert.ok(extension);
    await extension.activate();
    await vscode.commands.executeCommand("nextRecording.dev.ackPrivacyDisclosure");
  });

  teardown(async () => {
    // Ensure no session leaks between tests, even on failure.
    await vscode.commands.executeCommand("nextRecording.stop");
    await closeAllEditorsDiscardingChanges();
  });

  test("multi-root session records via start/stop and validates", async () => {
    assert.ok(
      (vscode.workspace.workspaceFolders?.length ?? 0) >= 2,
      "expected a multi-root workspace",
    );
    const uriA = createFile(rootPath(0), "rec-a.txt", "root a file\n");
    const uriB = createFile(rootPath(1), "rec-b.txt", "root b file\n");

    const start = (await vscode.commands.executeCommand("nextRecording.start")) as StartResult;
    assert.strictEqual(start.ok, true, "start failed");
    assert.strictEqual((await recorderState()).state, "recording");

    const editorA = await vscode.window.showTextDocument(uriA, {
      preview: false,
    });
    await editorA.edit((builder) => builder.insert(new vscode.Position(0, 0), "A! "));
    const editorB = await vscode.window.showTextDocument(uriB, {
      preview: false,
    });
    await editorB.edit((builder) => builder.insert(new vscode.Position(0, 0), "B! "));
    const untitled = await vscode.workspace.openTextDocument({
      language: "plaintext",
      content: "untitled scratch",
    });
    await vscode.window.showTextDocument(untitled, { preview: false });
    await sleep(250);

    const stop = (await vscode.commands.executeCommand("nextRecording.stop")) as StopResult;
    assert.strictEqual(stop.ok, true, `stop failed: ${JSON.stringify(stop)}`);
    assert.ok((stop.eventCount ?? 0) > 10, "too few events recorded");
    assert.strictEqual(stop.shadowMismatches, 0);
    assert.ok((stop.patches ?? 0) >= 2, "patches missing");
    assert.strictEqual((await recorderState()).state, "idle");

    // The finalized working session exists, is marked finalized, and its
    // journal replays (headless validation ran during stop; verify the
    // durable state independently).
    const sessionDir = stop.sessionDir!;
    const metadata = JSON.parse(fs.readFileSync(path.join(sessionDir, "session.json"), "utf8"));
    assert.strictEqual(metadata.state, "finalized");
    const finalized = JSON.parse(fs.readFileSync(path.join(sessionDir, "finalized.json"), "utf8"));
    assert.strictEqual(finalized.eventCount, stop.eventCount);
    assert.ok(Array.isArray(finalized.documents) && finalized.documents.length >= 3);

    // Multi-root evidence: journal contains two distinct rootIds among
    // enrolled documents plus a rootless untitled document.
    const journal = fs
      .readFileSync(path.join(sessionDir, "events.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const enrolled = journal.filter((event) => event.type === "document.enrolled");
    const rootIds = new Set(
      enrolled.map((event) => event.payload.descriptor.rootId).filter((rootId) => rootId !== null),
    );
    assert.ok(rootIds.size >= 2, `expected 2 rootIds, got ${rootIds.size}`);
    assert.ok(
      enrolled.some((event) => event.payload.descriptor.schemeClass === "untitled"),
      "untitled document missing",
    );
    const rootsSnapshots = journal.filter((event) => event.type === "roots.snapshot");
    assert.ok(rootsSnapshots[0].payload.roots.length >= 2, "roots.snapshot incomplete");
    assert.strictEqual(journal[journal.length - 1].type, "session.finalized");
  });

  test("second start is rejected while recording; stop is idempotent", async () => {
    const first = (await vscode.commands.executeCommand("nextRecording.start")) as StartResult;
    assert.strictEqual(first.ok, true);

    const second = (await vscode.commands.executeCommand("nextRecording.start")) as StartResult;
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.code, "already-active");

    const stop1 = (await vscode.commands.executeCommand("nextRecording.stop")) as StopResult;
    assert.strictEqual(stop1.ok, true);
    const stop2 = (await vscode.commands.executeCommand("nextRecording.stop")) as StopResult;
    assert.strictEqual(stop2.ok, false);
    assert.strictEqual(stop2.code, "not-recording");
    assert.strictEqual((await recorderState()).state, "idle");
  });

  test("abandoned session is discovered as recoverable", async () => {
    const uri = createFile(rootPath(0), "crash.txt", "before crash\n");
    const start = (await vscode.commands.executeCommand("nextRecording.start")) as StartResult;
    assert.strictEqual(start.ok, true);
    const sessionId = start.sessionId!;

    const editor = await vscode.window.showTextDocument(uri, {
      preview: false,
    });
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "boom "));
    await sleep(1500); // let the journal sync interval make events durable

    const abandonedDir = (await vscode.commands.executeCommand(
      "nextRecording.dev.simulateCrash",
    )) as string;
    assert.ok(abandonedDir, "no active session to abandon");

    const scan = (await vscode.commands.executeCommand(
      "nextRecording.dev.recoveryScan",
    )) as ScanEntry[];
    const entry = scan.find((candidate) => candidate.sessionId === sessionId);
    assert.ok(entry, "abandoned session not found by recovery scan");
    assert.strictEqual(entry.recoverable, true);
    assert.strictEqual(entry.state, "recording");

    const inspection = (await vscode.commands.executeCommand(
      "nextRecording.dev.recoveryInspect",
      sessionId,
    )) as { eventCount: number; corruption: unknown };
    assert.ok(inspection.eventCount > 0, "no durable events recovered");
    assert.strictEqual(inspection.corruption, null);

    await vscode.commands.executeCommand("nextRecording.dev.recoveryDiscard", sessionId);
    const rescan = (await vscode.commands.executeCommand(
      "nextRecording.dev.recoveryScan",
    )) as ScanEntry[];
    assert.ok(!rescan.some((candidate) => candidate.sessionId === sessionId));
  });

  test("abandoned session can be finalized into a playable artifact", async () => {
    const uri = createFile(rootPath(0), "recover-me.txt", "recover this\n");
    const start = (await vscode.commands.executeCommand("nextRecording.start")) as StartResult;
    assert.strictEqual(start.ok, true);
    const sessionId = start.sessionId!;

    const editor = await vscode.window.showTextDocument(uri, {
      preview: false,
    });
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "OK "));
    await sleep(1500); // journal sync interval

    await vscode.commands.executeCommand("nextRecording.dev.simulateCrash");

    const result = (await vscode.commands.executeCommand(
      "nextRecording.dev.recoveryFinalize",
      sessionId,
    )) as {
      ok: boolean;
      artifactPath?: string;
      recoveredEvents?: number;
      message?: string;
    };
    assert.strictEqual(result.ok, true, `finalize failed: ${result.message}`);
    assert.ok((result.recoveredEvents ?? 0) > 0);
    assert.ok(fs.existsSync(result.artifactPath!), "recovered artifact missing");

    // The recovered artifact passes the fail-closed reader stack.
    const summary = (await vscode.commands.executeCommand(
      "nextRecording.dev.readArtifact",
      result.artifactPath,
    )) as { eventCount: number; documents: string[] };
    assert.strictEqual(summary.eventCount, result.recoveredEvents);
    assert.ok(summary.documents.includes("recover-me.txt"));

    // Idempotent: a second finalize returns the same artifact.
    const again = (await vscode.commands.executeCommand(
      "nextRecording.dev.recoveryFinalize",
      sessionId,
    )) as { ok: boolean; alreadyFinalized?: boolean; artifactPath?: string };
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.alreadyFinalized, true);
    assert.strictEqual(again.artifactPath, result.artifactPath);

    // The session no longer shows as recoverable.
    const scan = (await vscode.commands.executeCommand(
      "nextRecording.dev.recoveryScan",
    )) as ScanEntry[];
    const entry = scan.find((candidate) => candidate.sessionId === sessionId);
    assert.ok(entry, "session directory disappeared unexpectedly");
    assert.strictEqual(entry.recoverable, false);
  });

  test("excluded globs are honored", async () => {
    const config = vscode.workspace.getConfiguration("nextRecording");
    await config.update("capture.exclude", ["**/*.secret"], vscode.ConfigurationTarget.Global);
    try {
      const uri = createFile(rootPath(0), "creds.secret", "api-key: hunter2\n");
      const start = (await vscode.commands.executeCommand("nextRecording.start")) as StartResult;
      assert.strictEqual(start.ok, true);
      await vscode.window.showTextDocument(uri, { preview: false });
      await sleep(250);
      const stop = (await vscode.commands.executeCommand("nextRecording.stop")) as StopResult;
      assert.strictEqual(stop.ok, true);

      const journal = fs
        .readFileSync(path.join(stop.sessionDir!, "events.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const enrolledSecret = journal.some(
        (event) =>
          event.type === "document.enrolled" &&
          event.payload.descriptor.displayName === "creds.secret",
      );
      assert.strictEqual(enrolledSecret, false, "excluded document was enrolled");
      assert.ok(
        journal.some(
          (event) =>
            event.type === "marker" &&
            String(event.payload.label).startsWith("document.excluded:file:excluded"),
        ),
        "exclusion marker missing",
      );
      // No captured content anywhere in the journal.
      assert.ok(
        !JSON.stringify(journal).includes("hunter2"),
        "excluded content leaked into the journal",
      );
    } finally {
      await config.update("capture.exclude", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
