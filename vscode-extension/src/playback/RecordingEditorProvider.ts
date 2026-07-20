import * as vscode from "vscode";
import { CONFIG_NAMESPACE, CONTEXT_KEYS, PLAYER_VIEW_TYPE } from "../model/ids";
import { parseWebviewMessage, PROTOCOL_VERSION } from "../webview/bridge/protocol";
import { getWebviewHtml } from "./getWebviewHtml";
import { PlaybackDataService } from "./PlaybackDataService";

class RecordingCustomDocument implements vscode.CustomDocument {
  service: PlaybackDataService | null = null;
  loadError: string | null = null;

  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {
    void this.service?.dispose();
    this.service = null;
  }
}

// Read-only custom editor player (plan §10.1). Playback never opens or
// modifies real workspace documents; everything happens in the webview.
export class RecordingEditorProvider implements vscode.CustomReadonlyEditorProvider<RecordingCustomDocument> {
  // Diagnostics: proves the webview bundle booted under the CSP (the
  // ready message is sent after the module graph, incl. Monaco, loads).
  static webviewReadyCount = 0;

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      PLAYER_VIEW_TYPE,
      new RecordingEditorProvider(context.extensionUri),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: false },
      },
    );
  }

  constructor(private readonly extensionUri: vscode.Uri) {}

  async openCustomDocument(uri: vscode.Uri): Promise<RecordingCustomDocument> {
    const document = new RecordingCustomDocument(uri);
    const fileName = uri.path.split("/").pop() ?? uri.path;
    try {
      // Validates archive paths, sizes, manifest, and integrity before any
      // content is served (plan §10.1, §13.2). Malformed artifacts fail
      // closed with a useful error surfaced by the webview.
      document.service = await PlaybackDataService.open(uri.fsPath, fileName);
    } catch (error) {
      document.loadError = error instanceof Error ? error.message : String(error);
    }
    return document;
  }

  async resolveCustomEditor(
    document: RecordingCustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    webview.html = getWebviewHtml(webview, this.extensionUri);

    let disposed = false;
    const post = (message: unknown) => {
      if (!disposed) {
        void webview.postMessage(message);
      }
    };

    const messageSubscription = webview.onDidReceiveMessage(async (raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (!message || disposed) {
        return; // invalid messages are dropped, never executed
      }
      switch (message.type) {
        case "webview.ready": {
          if (message.protocolVersion !== PROTOCOL_VERSION) {
            post({
              type: "request.failed",
              requestId: "open",
              message: `player protocol ${message.protocolVersion} is unsupported (expected ${PROTOCOL_VERSION})`,
            });
            return;
          }
          RecordingEditorProvider.webviewReadyCount += 1;
          post({ type: "host.hello", protocolVersion: PROTOCOL_VERSION });
          if (document.loadError !== null || !document.service) {
            post({
              type: "request.failed",
              requestId: "open",
              message: document.loadError ?? "artifact could not be opened",
            });
            return;
          }
          post({
            type: "recording.metadata",
            payload: document.service.metadata(
              vscode.workspace
                .getConfiguration(CONFIG_NAMESPACE)
                .get<number>("playback.defaultSpeed") ?? 1,
            ),
          });
          break;
        }
        case "recording.requestWindow": {
          if (!document.service) {
            post({
              type: "request.failed",
              requestId: message.requestId,
              message: "no artifact loaded",
            });
            return;
          }
          try {
            const window = await document.service.eventWindow(message.fromSeq, message.maxCount);
            post({
              type: "recording.eventWindow",
              requestId: message.requestId,
              fromSeq: message.fromSeq,
              events: window.events,
              done: window.done,
            });
          } catch (error) {
            post({
              type: "request.failed",
              requestId: message.requestId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }
        case "recording.requestCheckpoint": {
          if (!document.service) {
            post({
              type: "request.failed",
              requestId: message.requestId,
              message: "no artifact loaded",
            });
            return;
          }
          try {
            const text = await document.service.checkpoint(
              message.documentId,
              message.checkpointId,
            );
            post({
              type: "recording.checkpoint",
              requestId: message.requestId,
              documentId: message.documentId,
              checkpointId: message.checkpointId,
              text,
            });
          } catch (error) {
            post({
              type: "request.failed",
              requestId: message.requestId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }
        case "player.stateChanged":
          // Reserved for future host-side UI (timeline in the tab title).
          break;
        case "webview.error":
          console.warn(`[next-recording] webview error: ${message.message}`);
          break;
      }
    });

    const viewStateSubscription = webviewPanel.onDidChangeViewState(() => {
      void vscode.commands.executeCommand(
        "setContext",
        CONTEXT_KEYS.playerActive,
        webviewPanel.active,
      );
      if (!webviewPanel.visible) {
        post({ type: "player.pause" });
      }
    });

    webviewPanel.onDidDispose(() => {
      disposed = true;
      messageSubscription.dispose();
      viewStateSubscription.dispose();
      void vscode.commands.executeCommand("setContext", CONTEXT_KEYS.playerActive, false);
    });
  }
}
