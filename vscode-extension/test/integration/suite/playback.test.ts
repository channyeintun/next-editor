import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

type StopResult = {
  ok: boolean;
  artifactPath?: string;
  eventCount?: number;
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

suite("artifact playback", function () {
  this.timeout(120_000);

  let artifactPath: string;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension("channyeintun.next-recording");
    assert.ok(extension);
    await extension.activate();
    await vscode.commands.executeCommand("nextRecording.dev.ackPrivacyDisclosure");

    // Record a small real session to obtain an artifact.
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    const file = path.join(root.uri.fsPath, "playback-src.txt");
    fs.writeFileSync(file, "first line\nsecond line\n", "utf8");

    const start = (await vscode.commands.executeCommand("nextRecording.start")) as {
      ok: boolean;
    };
    assert.strictEqual(start.ok, true);
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file), {
      preview: false,
    });
    await editor.edit((builder) => builder.insert(new vscode.Position(1, 0), "inserted "));
    await sleep(200);
    const stop = (await vscode.commands.executeCommand("nextRecording.stop")) as StopResult;
    assert.strictEqual(stop.ok, true, "recording failed");
    assert.ok(stop.artifactPath, "no artifact produced");
    artifactPath = stop.artifactPath;
    await closeAllEditorsDiscardingChanges();
  });

  teardown(async () => {
    await closeAllEditorsDiscardingChanges();
  });

  test("finalized artifact exists and passes the reader stack", async () => {
    assert.ok(fs.existsSync(artifactPath), "artifact file missing");
    const summary = (await vscode.commands.executeCommand(
      "nextRecording.dev.readArtifact",
      artifactPath,
    )) as {
      eventCount: number;
      documents: string[];
      firstWindowSize: number;
      checkpointLength: number | null;
    };
    assert.ok(summary.eventCount > 5, "artifact has too few events");
    assert.ok(summary.documents.includes("playback-src.txt"));
    assert.ok(summary.firstWindowSize > 0);
    assert.ok((summary.checkpointLength ?? 0) > 0, "initial checkpoint unreadable");
  });

  test("player opens the artifact without touching workspace documents", async () => {
    // A real workspace document to watch for illegal modifications.
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    const watched = path.join(root.uri.fsPath, "watched.txt");
    fs.writeFileSync(watched, "must stay untouched\n", "utf8");
    const watchedDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(watched));
    const versionBefore = watchedDoc.version;

    const statusBefore = (await vscode.commands.executeCommand(
      "nextRecording.dev.playerStatus",
    )) as { webviewReadyCount: number };

    await vscode.commands.executeCommand(
      "vscode.openWith",
      vscode.Uri.file(artifactPath),
      "nextRecording.player",
    );
    await sleep(2000); // let the webview boot, load events, and render

    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(activeTab, "no active tab");
    assert.ok(
      activeTab.input instanceof vscode.TabInputCustom,
      "player tab is not a custom editor",
    );
    assert.strictEqual(activeTab.input.viewType, "nextRecording.player");

    // The ready handshake proves the player bundle (including Monaco)
    // executed under the strict CSP inside the webview.
    const statusAfter = (await vscode.commands.executeCommand(
      "nextRecording.dev.playerStatus",
    )) as { webviewReadyCount: number };
    assert.ok(
      statusAfter.webviewReadyCount > statusBefore.webviewReadyCount,
      "player webview never sent webview.ready — the bundle did not boot",
    );

    // Playback must not add versions, dirty state, or new text documents
    // pointing at recorded resources (plan §4.1, §17.2).
    assert.strictEqual(watchedDoc.version, versionBefore, "document version changed");
    assert.strictEqual(watchedDoc.isDirty, false, "document became dirty");
    const dirtyDocs = vscode.workspace.textDocuments.filter((doc) => doc.isDirty);
    assert.deepStrictEqual(
      dirtyDocs.map((doc) => doc.uri.toString()),
      [],
      "playback dirtied documents",
    );
  });

  test("corrupt artifacts fail closed in the custom editor", async () => {
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    const corrupt = path.join(root.uri.fsPath, "corrupt.nextrecording");
    fs.writeFileSync(corrupt, "this is not a zip file at all");

    // Opening must not throw out of the provider; the webview shows an
    // error view and no service is created.
    await vscode.commands.executeCommand(
      "vscode.openWith",
      vscode.Uri.file(corrupt),
      "nextRecording.player",
    );
    await sleep(500);
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(activeTab?.input instanceof vscode.TabInputCustom);
  });
});
