import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CaptureSession } from "../capture/CaptureSession";
import { InMemoryEventSink } from "../capture/EventSink";
import { COMMAND_NAMESPACE } from "../model/ids";

// Phase 2 diagnostic commands (not contributed to the palette): drive a
// capture spike session and inspect its trace. Removed before release
// (plan §15 Phase 9).
export type CaptureTrace = {
  sessionId: string;
  stopped: boolean;
  events: unknown[];
  checkpoints: {
    meta: unknown;
    textSha256Prefix: string;
    textLength: number;
  }[];
  checkpointTexts: Record<string, string>;
  counters: Record<string, number>;
  metrics: Record<string, unknown>;
};

let activeSpike: { session: CaptureSession; sink: InMemoryEventSink } | null = null;

function buildTrace(): CaptureTrace | null {
  if (!activeSpike) {
    return null;
  }
  const { session, sink } = activeSpike;
  const checkpointTexts: Record<string, string> = {};
  for (const [id, checkpoint] of sink.checkpoints) {
    checkpointTexts[id] = checkpoint.text;
  }
  return {
    sessionId: session.sessionId,
    stopped: session.isStopped,
    events: sink.events as unknown[],
    checkpoints: [...sink.checkpoints.values()].map(({ meta, text }) => ({
      meta,
      textSha256Prefix: meta.sha256.slice(0, 12),
      textLength: text.length,
    })),
    checkpointTexts,
    counters: session.countersSnapshot() as unknown as Record<string, number>,
    metrics: session.metrics.summary(),
  };
}

export function registerDevCommands(context: vscode.ExtensionContext): void {
  const ns = `${COMMAND_NAMESPACE}.dev`;
  context.subscriptions.push(
    vscode.commands.registerCommand(`${ns}.captureStart`, () => {
      if (activeSpike && !activeSpike.session.isStopped) {
        return activeSpike.session.sessionId;
      }
      const sink = new InMemoryEventSink();
      const session = new CaptureSession(
        sink,
        String(context.extension.packageJSON.version ?? "0.0.0"),
      );
      activeSpike = { session, sink };
      session.start();
      return session.sessionId;
    }),

    vscode.commands.registerCommand(`${ns}.captureStop`, () => {
      if (!activeSpike) {
        return null;
      }
      activeSpike.session.stop();
      return activeSpike.session.countersSnapshot();
    }),

    vscode.commands.registerCommand(`${ns}.captureTrace`, () => buildTrace()),

    vscode.commands.registerCommand(`${ns}.dumpTrace`, async () => {
      const trace = buildTrace();
      if (!trace) {
        void vscode.window.showWarningMessage("Next Recording: no capture spike active.");
        return null;
      }
      const lines: string[] = [
        `session ${trace.sessionId} stopped=${trace.stopped}`,
        `counters ${JSON.stringify(trace.counters)}`,
        `metrics ${JSON.stringify(trace.metrics, null, 2)}`,
        "events:",
      ];
      for (const event of trace.events as {
        seq: number;
        tUs: number;
        type: string;
        payload: unknown;
      }[]) {
        lines.push(
          `  #${event.seq} t=${(event.tUs / 1000).toFixed(1)}ms ${event.type} ${JSON.stringify(event.payload).slice(0, 300)}`,
        );
      }
      const file = path.join(os.tmpdir(), `next-recording-trace-${Date.now()}.txt`);
      fs.writeFileSync(file, lines.join("\n"), "utf8");
      void vscode.window.showInformationMessage(`Next Recording: trace written to ${file}`);
      return file;
    }),

    vscode.commands.registerCommand(`${ns}.captureDiscard`, () => {
      if (activeSpike) {
        activeSpike.session.stop();
        activeSpike = null;
      }
    }),
  );
}
