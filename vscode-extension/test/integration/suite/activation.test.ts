import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const EXTENSION_ID = "channyeintun.next-recording";
const PLAYER_VIEW_TYPE = "nextRecording.player";

suite("activation", () => {
  test("extension activates", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  test("contributed commands are registered", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "nextRecording.start",
      "nextRecording.stop",
      "nextRecording.recover",
      "nextRecording.open",
      "nextRecording.export",
    ]) {
      assert.ok(commands.includes(command), `missing command ${command}`);
    }
  });

  test("custom editor opens a synthetic .nextrecording fixture", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "next-recording-fixture-"));
    const fixturePath = path.join(dir, "sample.nextrecording");
    // Phase 1 placeholder player does not parse content yet.
    fs.writeFileSync(fixturePath, "synthetic-fixture");

    try {
      const uri = vscode.Uri.file(fixturePath);
      await vscode.commands.executeCommand("vscode.openWith", uri, PLAYER_VIEW_TYPE);

      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(activeTab, "no active tab after opening the recording");
      assert.ok(
        activeTab.input instanceof vscode.TabInputCustom,
        "active tab is not a custom editor",
      );
      assert.strictEqual(activeTab.input.viewType, PLAYER_VIEW_TYPE);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
