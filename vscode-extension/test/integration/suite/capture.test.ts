import * as assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

type AnyEvent = { seq: number; tUs: number; type: string; payload: any };
type Trace = {
  sessionId: string;
  events: AnyEvent[];
  checkpoints: { meta: any; textLength: number }[];
  checkpointTexts: Record<string, string>;
  counters: Record<string, number>;
  metrics: Record<string, { count: number; meanUs: number; p95Us: number; maxUs: number }>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

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

async function startSpike(): Promise<void> {
  await vscode.commands.executeCommand("nextRecording.dev.captureDiscard");
  await closeAllEditorsDiscardingChanges();
  await sleep(50);
  await vscode.commands.executeCommand("nextRecording.dev.captureStart");
}

async function stopSpike(): Promise<Trace> {
  await sleep(150); // allow viewport coalescing and topology microtasks
  await vscode.commands.executeCommand("nextRecording.dev.captureStop");
  const trace = (await vscode.commands.executeCommand("nextRecording.dev.captureTrace")) as Trace;
  assert.ok(trace, "no trace returned");
  return trace;
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "integration workspace missing");
  return folder.uri.fsPath;
}

function createWorkspaceFile(name: string, content: string): vscode.Uri {
  const file = path.join(workspaceRoot(), name);
  fs.writeFileSync(file, content, "utf8");
  return vscode.Uri.file(file);
}

function eventsOf(trace: Trace, type: string): AnyEvent[] {
  return trace.events.filter((event) => event.type === type);
}

function patchesFor(trace: Trace, documentId: string): AnyEvent[] {
  return eventsOf(trace, "document.patch").filter(
    (event) => event.payload.documentId === documentId,
  );
}

function assertEnvelopeInvariants(trace: Trace): void {
  let lastTUs = -1;
  trace.events.forEach((event, index) => {
    assert.strictEqual(event.seq, index, `seq gap at index ${index}`);
    assert.ok(event.tUs >= lastTUs, `tUs decreased at seq ${event.seq}`);
    lastTUs = event.tUs;
  });
}

function documentIdByName(trace: Trace, displayName: string): string {
  const enrolled = eventsOf(trace, "document.enrolled").find(
    (event) => event.payload.descriptor.displayName === displayName,
  );
  assert.ok(enrolled, `document ${displayName} not enrolled`);
  return enrolled.payload.descriptor.documentId;
}

suite("capture model", function () {
  this.timeout(120_000);

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension("channyeintun.next-recording");
    assert.ok(extension);
    await extension.activate();
  });

  teardown(async () => {
    await vscode.commands.executeCommand("nextRecording.dev.captureDiscard");
    await closeAllEditorsDiscardingChanges();
  });

  test("records edits across two documents with exact shadows", async () => {
    const uriA = createWorkspaceFile("a.txt", "alpha\n");
    const uriB = createWorkspaceFile("b.txt", "beta\n");
    await startSpike();

    const editorA = await vscode.window.showTextDocument(uriA, {
      preview: false,
    });
    await editorA.edit((builder) => builder.insert(new vscode.Position(0, 5), " one"));
    const finalA = editorA.document.getText();
    const editorB = await vscode.window.showTextDocument(uriB, {
      preview: false,
    });
    await editorB.edit((builder) => builder.insert(new vscode.Position(0, 4), " two"));
    const finalB = editorB.document.getText();

    const trace = await stopSpike();
    assertEnvelopeInvariants(trace);
    assert.strictEqual(trace.counters.shadowMismatches, 0);

    const idA = documentIdByName(trace, "a.txt");
    const idB = documentIdByName(trace, "b.txt");
    assert.notStrictEqual(idA, idB);

    const patchesA = patchesFor(trace, idA);
    const patchesB = patchesFor(trace, idB);
    assert.ok(patchesA.length >= 1, "no patches for a.txt");
    assert.ok(patchesB.length >= 1, "no patches for b.txt");
    assert.strictEqual(patchesA[patchesA.length - 1]!.payload.afterHash, sha256(finalA));
    assert.strictEqual(patchesB[patchesB.length - 1]!.payload.afterHash, sha256(finalB));

    // Initial checkpoints captured exact initial content.
    const enrolledA = eventsOf(trace, "document.enrolled").find(
      (e) => e.payload.descriptor.documentId === idA,
    )!;
    const checkpointText = trace.checkpointTexts[enrolledA.payload.descriptor.initialCheckpointId];
    assert.strictEqual(checkpointText, "alpha\n");
  });

  test("same document in two groups: one documentId, two surfaces", async () => {
    const uri = createWorkspaceFile("dup.txt", "line1\nline2\nline3\n");
    await startSpike();

    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.One,
    });
    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.Two,
    });
    await sleep(200);

    const editor = vscode.window.visibleTextEditors.find(
      (candidate) =>
        candidate.document.uri.toString() === uri.toString() &&
        candidate.viewColumn === vscode.ViewColumn.Two,
    );
    assert.ok(editor, "second surface editor not visible");
    editor.selections = [new vscode.Selection(1, 0, 1, 5)];
    await sleep(200);

    const trace = await stopSpike();
    assertEnvelopeInvariants(trace);

    const enrolled = eventsOf(trace, "document.enrolled").filter(
      (event) => event.payload.descriptor.displayName === "dup.txt",
    );
    assert.strictEqual(enrolled.length, 1, "document enrolled more than once");
    const documentId = enrolled[0]!.payload.descriptor.documentId;

    const opened = eventsOf(trace, "surface.opened").filter(
      (event) => event.payload.documentId === documentId,
    );
    const surfaceIds = new Set(opened.map((event) => event.payload.surfaceId));
    assert.ok(surfaceIds.size >= 2, `expected >=2 surfaces, got ${surfaceIds.size}`);

    // Topology: two groups, each containing a text tab for this document.
    const topologies = eventsOf(trace, "topology.snapshot");
    assert.ok(topologies.length >= 1, "no topology snapshots");
    const last = topologies[topologies.length - 1]!.payload;
    assert.strictEqual(last.fidelity, "reconstructed-no-geometry");
    const groupsWithDoc = last.groups.filter((group: any) =>
      group.tabs.some((tab: any) => tab.documentId === documentId),
    );
    assert.strictEqual(groupsWithDoc.length, 2, "document not visible in two groups");

    // The selection change targeted exactly one surface.
    const selectionEvents = eventsOf(trace, "surface.selectionChanged").filter(
      (event) =>
        event.payload.documentId === documentId &&
        event.payload.selections.some((s: any) => s.activeOffsetUtf16 !== s.anchorOffsetUtf16),
    );
    assert.ok(selectionEvents.length >= 1, "no non-empty selection recorded");
    const selectionSurfaces = new Set(selectionEvents.map((e) => e.payload.surfaceId));
    assert.strictEqual(selectionSurfaces.size, 1, "selection leaked across surfaces");
  });

  test("multi-cursor edit is one atomic patch with multiple changes", async () => {
    const uri = createWorkspaceFile("multi.txt", "aaa\nbbb\nccc\n");
    await startSpike();

    const editor = await vscode.window.showTextDocument(uri);
    editor.selections = [
      new vscode.Selection(0, 0, 0, 0),
      new vscode.Selection(1, 0, 1, 0),
      new vscode.Selection(2, 0, 2, 0),
    ];
    await editor.edit((builder) => {
      builder.insert(new vscode.Position(0, 0), "1");
      builder.insert(new vscode.Position(1, 0), "2");
      builder.insert(new vscode.Position(2, 0), "3");
    });
    const finalText = editor.document.getText();
    assert.strictEqual(finalText, "1aaa\n2bbb\n3ccc\n");

    const trace = await stopSpike();
    assert.strictEqual(trace.counters.shadowMismatches, 0);
    const documentId = documentIdByName(trace, "multi.txt");
    const patches = patchesFor(trace, documentId);
    assert.strictEqual(patches.length, 1, "expected exactly one patch event");
    assert.strictEqual(patches[0]!.payload.changes.length, 3);
    assert.strictEqual(patches[0]!.payload.afterHash, sha256(finalText));
  });

  test("undo and redo record their reasons", async () => {
    const uri = createWorkspaceFile("undo.txt", "start\n");
    await startSpike();

    const editor = await vscode.window.showTextDocument(uri);
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 5), "!"));
    await sleep(100);
    await vscode.commands.executeCommand("undo");
    await sleep(100);
    await vscode.commands.executeCommand("redo");
    await sleep(100);

    const trace = await stopSpike();
    assert.strictEqual(trace.counters.shadowMismatches, 0);
    const documentId = documentIdByName(trace, "undo.txt");
    const reasons = patchesFor(trace, documentId).map((event) => event.payload.reason);
    assert.ok(reasons.includes("undo"), `no undo patch in ${JSON.stringify(reasons)}`);
    assert.ok(reasons.includes("redo"), `no redo patch in ${JSON.stringify(reasons)}`);
  });

  test("workspace edit (formatter-style full replace) stays consistent", async () => {
    const uri = createWorkspaceFile("fmt.txt", "unformatted   text\n\n\nend\n");
    await startSpike();

    const editor = await vscode.window.showTextDocument(uri);
    const document = editor.document;
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      document.lineAt(document.lineCount - 1).range.end,
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, "formatted text\nend");
    const applied = await vscode.workspace.applyEdit(edit);
    assert.ok(applied, "workspace edit not applied");
    await sleep(100);

    const trace = await stopSpike();
    assert.strictEqual(trace.counters.shadowMismatches, 0);
    const documentId = documentIdByName(trace, "fmt.txt");
    const patches = patchesFor(trace, documentId);
    assert.ok(patches.length >= 1);
    assert.strictEqual(patches[patches.length - 1]!.payload.afterHash, sha256(document.getText()));
  });

  test("untitled document enrolls with null root and untitled scheme", async () => {
    await startSpike();

    const document = await vscode.workspace.openTextDocument({
      language: "plaintext",
      content: "scratch content",
    });
    await vscode.window.showTextDocument(document);
    await sleep(200);

    const trace = await stopSpike();
    const enrolled = eventsOf(trace, "document.enrolled").find(
      (event) => event.payload.descriptor.schemeClass === "untitled",
    );
    assert.ok(enrolled, "untitled document not enrolled");
    assert.strictEqual(enrolled.payload.descriptor.rootId, null);
    assert.strictEqual(
      trace.checkpointTexts[enrolled.payload.descriptor.initialCheckpointId],
      "scratch content",
    );
  });

  test("diff editor is recorded as an unsupported surface", async () => {
    const uriA = createWorkspaceFile("diff-a.txt", "one\ntwo\n");
    const uriB = createWorkspaceFile("diff-b.txt", "one\nTWO\n");
    await startSpike();

    await vscode.commands.executeCommand("vscode.diff", uriA, uriB, "a ↔ b");
    await sleep(300);

    const trace = await stopSpike();
    const unsupported = eventsOf(trace, "capability.unsupportedSurface");
    assert.ok(
      unsupported.some((event) => event.payload.kind === "textDiff"),
      `no textDiff unsupported marker in ${JSON.stringify(unsupported.map((e) => e.payload))}`,
    );
    const topologies = eventsOf(trace, "topology.snapshot");
    const lastTopology = topologies[topologies.length - 1]!.payload;
    const diffTabs = lastTopology.groups.flatMap((group: any) =>
      group.tabs.filter((tab: any) => tab.kind === "textDiff"),
    );
    assert.strictEqual(diffTabs.length, 1, "diff tab missing from topology");
  });

  test("rapid edit burst loses no transactions", async () => {
    const uri = createWorkspaceFile("burst.txt", "");
    await startSpike();

    const editor = await vscode.window.showTextDocument(uri);
    const EDITS = 120;
    for (let i = 0; i < EDITS; i++) {
      const end = editor.document.positionAt(editor.document.getText().length);
      const ok = await editor.edit((builder) => builder.insert(end, `x${i % 10}`), {
        undoStopBefore: false,
        undoStopAfter: false,
      });
      assert.ok(ok, `edit ${i} failed`);
    }
    const finalText = editor.document.getText();

    const trace = await stopSpike();
    assert.strictEqual(trace.counters.shadowMismatches, 0, "shadow diverged");

    const documentId = documentIdByName(trace, "burst.txt");
    const patches = patchesFor(trace, documentId);
    assert.strictEqual(patches.length, EDITS, "content transactions were lost");
    for (let i = 1; i < patches.length; i++) {
      assert.strictEqual(
        patches[i]!.payload.beforeVersion,
        patches[i - 1]!.payload.afterVersion,
        `version chain broken at patch ${i}`,
      );
      assert.strictEqual(
        patches[i]!.payload.beforeHash,
        patches[i - 1]!.payload.afterHash,
        `hash chain broken at patch ${i}`,
      );
    }
    assert.strictEqual(patches[patches.length - 1]!.payload.afterHash, sha256(finalText));

    // Capture budget sanity (plan §17.1): mean well under 10ms.
    const textMetrics = trace.metrics.textChange;
    assert.ok(textMetrics, "no textChange metrics recorded");
    assert.ok(textMetrics.meanUs < 10_000, `textChange mean ${textMetrics.meanUs}us exceeds 10ms`);
  });

  test("topology snapshots are deduplicated and structurally coherent", async () => {
    const uriA = createWorkspaceFile("topo-a.txt", "a\n");
    const uriB = createWorkspaceFile("topo-b.txt", "b\n");
    await startSpike();

    await vscode.window.showTextDocument(uriA, {
      viewColumn: vscode.ViewColumn.One,
    });
    await vscode.window.showTextDocument(uriB, {
      viewColumn: vscode.ViewColumn.Two,
    });
    await sleep(150);
    await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
    await sleep(150);

    const trace = await stopSpike();
    const topologies = eventsOf(trace, "topology.snapshot");
    assert.ok(topologies.length >= 1);

    for (let i = 1; i < topologies.length; i++) {
      assert.notStrictEqual(
        JSON.stringify(topologies[i]!.payload),
        JSON.stringify(topologies[i - 1]!.payload),
        "identical consecutive topology snapshots were not deduplicated",
      );
    }

    for (const snapshot of topologies) {
      const payload = snapshot.payload;
      const groupIds = new Set(payload.groups.map((group: any) => group.groupId));
      assert.strictEqual(groupIds.size, payload.groups.length, "duplicate groupId");
      if (payload.activeGroupId !== null) {
        assert.ok(groupIds.has(payload.activeGroupId), "activeGroupId not in groups");
      }
      const columns = payload.groups.map((group: any) => group.viewColumn);
      assert.deepStrictEqual(
        columns,
        [...columns].sort((a: number, b: number) => a - b),
      );
      for (const group of payload.groups) {
        if (group.activeTabId !== null) {
          assert.ok(
            group.tabs.some((tab: any) => tab.tabId === group.activeTabId),
            "activeTabId not among the group's tabs",
          );
        }
        const tabIds = new Set(group.tabs.map((tab: any) => tab.tabId));
        assert.strictEqual(tabIds.size, group.tabs.length, "duplicate tabId in group");
      }
    }

    const last = topologies[topologies.length - 1]!.payload;
    assert.strictEqual(last.groups.length, 2, "expected two groups in final topology");
  });
});
