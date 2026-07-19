// Renderer benchmark harness (plan §11.3). Runs inside a real VS Code
// webview so measurements reflect the production environment. Fixtures are
// generated in-page from seeded PRNGs; only results cross the bridge.
import type { SessionEvent } from "../../model/events";
import { CodeMirrorRenderer } from "../player/codemirror/CodeMirrorRenderer";
import {
  benchmarkFixtureConfigs,
  generateFixture,
  type BenchmarkFixture,
} from "../player/fixtures";
import { MonacoRenderer } from "../player/monaco/MonacoRenderer";
import { afterFrame, type PlaybackRenderer, type RendererId } from "../player/Renderer";
import { SessionReducer } from "../player/SessionReducer";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

const post = (message: unknown) => vscode.postMessage(message);
const progress = (note: string) => post({ type: "bench.progress", note });

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
  };
}

function heapUsed(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize : null;
}

const root = document.getElementById("root") as HTMLElement;

function makeContainer(): HTMLElement {
  const div = document.createElement("div");
  div.style.width = "420px";
  div.style.height = "280px";
  div.style.display = "inline-block";
  div.style.overflow = "hidden";
  root.appendChild(div);
  return div;
}

function clearContainers(): void {
  root.textContent = "";
}

function createRenderer(id: RendererId): PlaybackRenderer {
  return id === "monaco" ? new MonacoRenderer() : new CodeMirrorRenderer();
}

type SeekPlan = {
  checkpointsByDoc: Map<string, { eventIndex: number; checkpointId: string }[]>;
  patchIndexesByDoc: Map<string, number[]>;
  selectionIndexesBySurface: Map<string, number[]>;
  viewportIndexesBySurface: Map<string, number[]>;
};

function buildSeekPlan(fixture: BenchmarkFixture): SeekPlan {
  const plan: SeekPlan = {
    checkpointsByDoc: new Map(),
    patchIndexesByDoc: new Map(),
    selectionIndexesBySurface: new Map(),
    viewportIndexesBySurface: new Map(),
  };
  fixture.events.forEach((event, index) => {
    if (event.type === "document.enrolled") {
      const d = event.payload.descriptor;
      plan.checkpointsByDoc.set(d.documentId, [
        { eventIndex: index, checkpointId: d.initialCheckpointId },
      ]);
    } else if (event.type === "document.checkpoint") {
      plan.checkpointsByDoc
        .get(event.payload.documentId)
        ?.push({ eventIndex: index, checkpointId: event.payload.checkpointId });
    } else if (event.type === "document.patch") {
      const list = plan.patchIndexesByDoc.get(event.payload.documentId) ?? [];
      list.push(index);
      plan.patchIndexesByDoc.set(event.payload.documentId, list);
    } else if (event.type === "surface.selectionChanged") {
      const list = plan.selectionIndexesBySurface.get(event.payload.surfaceId) ?? [];
      list.push(index);
      plan.selectionIndexesBySurface.set(event.payload.surfaceId, list);
    } else if (event.type === "surface.viewportChanged") {
      const list = plan.viewportIndexesBySurface.get(event.payload.surfaceId) ?? [];
      list.push(index);
      plan.viewportIndexesBySurface.set(event.payload.surfaceId, list);
    }
  });
  return plan;
}

function latestAtOrBefore(sortedIndexes: number[], target: number): number | null {
  let lo = 0;
  let hi = sortedIndexes.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = sortedIndexes[mid] as number;
    if (value <= target) {
      best = value;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

async function seekTo(
  renderer: PlaybackRenderer,
  fixture: BenchmarkFixture,
  plan: SeekPlan,
  target: number,
): Promise<number> {
  const start = performance.now();
  for (const [documentId, checkpoints] of plan.checkpointsByDoc) {
    let checkpoint = checkpoints[0] as {
      eventIndex: number;
      checkpointId: string;
    };
    for (const candidate of checkpoints) {
      if (candidate.eventIndex <= target) {
        checkpoint = candidate;
      } else {
        break;
      }
    }
    if (checkpoint.eventIndex > target) {
      continue; // document not enrolled yet at this time
    }
    renderer.setDocumentText(
      documentId,
      fixture.checkpointBodies[checkpoint.checkpointId] as string,
    );
    const patchIndexes = plan.patchIndexesByDoc.get(documentId) ?? [];
    for (const index of patchIndexes) {
      if (index > checkpoint.eventIndex && index <= target) {
        const event = fixture.events[index] as Extract<SessionEvent, { type: "document.patch" }>;
        renderer.applyChanges(documentId, event.payload.changes);
      }
    }
  }
  for (const [surfaceId, indexes] of plan.selectionIndexesBySurface) {
    const latest = latestAtOrBefore(indexes, target);
    if (latest !== null) {
      const event = fixture.events[latest] as Extract<
        SessionEvent,
        { type: "surface.selectionChanged" }
      >;
      renderer.setSelections(surfaceId, event.payload.selections);
    }
  }
  for (const [surfaceId, indexes] of plan.viewportIndexesBySurface) {
    const latest = latestAtOrBefore(indexes, target);
    if (latest !== null) {
      const event = fixture.events[latest] as Extract<
        SessionEvent,
        { type: "surface.viewportChanged" }
      >;
      renderer.setViewport(surfaceId, event.payload.visibleRanges);
    }
  }
  await afterFrame();
  return performance.now() - start;
}

async function runFixture(rendererId: RendererId, fixture: BenchmarkFixture) {
  clearContainers();
  const renderer = createRenderer(rendererId);
  const reducer = new SessionReducer((id) => fixture.checkpointBodies[id]);
  const surfaceContainers = new Map<string, HTMLElement>();

  // --- initial load to first paint --------------------------------------
  const initialEnd = fixture.events.findIndex((event) => event.type === "topology.snapshot");
  const loadStart = performance.now();
  let index = 0;
  for (; index <= initialEnd; index++) {
    const event = fixture.events[index] as SessionEvent;
    reducer.apply(event);
    if (event.type === "document.enrolled") {
      const d = event.payload.descriptor;
      renderer.createDocument(
        d.documentId,
        fixture.checkpointBodies[d.initialCheckpointId] as string,
        d.languageId,
      );
    } else if (event.type === "surface.opened") {
      const container = makeContainer();
      surfaceContainers.set(event.payload.surfaceId, container);
      renderer.createSurface(event.payload.surfaceId, event.payload.documentId, container);
    }
  }
  await afterFrame();
  const firstPaintMs = Number((performance.now() - loadStart).toFixed(2));

  // --- surface creation scaling (multi-surface fixture only) ------------
  let surfaceCreation: Record<string, number> | null = null;
  if (fixture.name === "multi-surface") {
    surfaceCreation = {};
    const doc = fixture.documentIds[0] as string;
    for (const count of [1, 5, 10, 20]) {
      const created: string[] = [];
      const t0 = performance.now();
      for (let i = 0; i < count; i++) {
        const id = `bench-scale-${count}-${i}`;
        renderer.createSurface(id, doc, makeContainer());
        created.push(id);
      }
      await afterFrame();
      surfaceCreation[String(count)] = Number((performance.now() - t0).toFixed(2));
      for (const id of created) {
        renderer.disposeSurface(id);
      }
      await afterFrame();
    }
  }

  // --- event replay with sampled patch-to-paint --------------------------
  const patchTotal = fixture.events.reduce(
    (sum, event) => (event.type === "document.patch" ? sum + 1 : sum),
    0,
  );
  const sampleEvery = Math.max(1, Math.floor(patchTotal / 150));
  const patchSamples: number[] = [];
  let patchCounter = 0;
  const replayStart = performance.now();

  for (; index < fixture.events.length; index++) {
    const event = fixture.events[index] as SessionEvent;
    reducer.apply(event);
    switch (event.type) {
      case "document.patch": {
        patchCounter += 1;
        if (patchCounter % sampleEvery === 0) {
          const t0 = performance.now();
          renderer.applyChanges(event.payload.documentId, event.payload.changes);
          await afterFrame();
          patchSamples.push(performance.now() - t0);
        } else {
          renderer.applyChanges(event.payload.documentId, event.payload.changes);
        }
        break;
      }
      case "document.checkpoint": {
        renderer.setDocumentText(
          event.payload.documentId,
          fixture.checkpointBodies[event.payload.checkpointId] as string,
        );
        break;
      }
      case "surface.selectionChanged":
        renderer.setSelections(event.payload.surfaceId, event.payload.selections);
        break;
      case "surface.viewportChanged":
        renderer.setViewport(event.payload.surfaceId, event.payload.visibleRanges);
        break;
      default:
        break;
    }
    if (index % 5000 === 0) {
      await afterFrame(); // yield to keep the page responsive
    }
  }
  const replayMs = Number((performance.now() - replayStart).toFixed(0));

  // --- correctness --------------------------------------------------------
  let finalTextsMatch = true;
  for (const documentId of fixture.documentIds) {
    const expected = reducer.state.documents.get(documentId)?.text ?? "";
    if (renderer.getDocumentText(documentId) !== expected) {
      finalTextsMatch = false;
    }
  }

  // --- hidden-surface suspension ------------------------------------------
  const doc0 = fixture.documentIds[0] as string;
  const canonical = renderer.getDocumentText(doc0);
  const doc0Surfaces = [...surfaceContainers.entries()].filter(
    ([surfaceId]) => reducer.state.surfaces.get(surfaceId)?.documentId === doc0,
  );
  for (const [surfaceId] of doc0Surfaces) {
    renderer.suspendSurface(surfaceId);
  }
  let hidden = canonical;
  for (let i = 0; i < 100; i++) {
    renderer.applyChanges(doc0, [{ rangeOffsetUtf16: 0, rangeLengthUtf16: 0, text: "x" }]);
    hidden = `x${hidden}`;
  }
  const resumeStart = performance.now();
  for (const [surfaceId, container] of doc0Surfaces) {
    renderer.resumeSurface(surfaceId, container);
  }
  await afterFrame();
  const resumeMs = Number((performance.now() - resumeStart).toFixed(2));
  const resumedCorrect = renderer.getDocumentText(doc0) === hidden;
  renderer.setDocumentText(doc0, canonical);

  const memoryAfterLoad = heapUsed();

  // --- seeks ---------------------------------------------------------------
  const plan = buildSeekPlan(fixture);
  const seekSamples: number[] = [];
  for (const target of fixture.seekPoints) {
    seekSamples.push(await seekTo(renderer, fixture, plan, target));
  }
  // Memory pressure: 100 seeks cycling through the targets.
  for (let i = 0; i < 100; i++) {
    const target = fixture.seekPoints[i % fixture.seekPoints.length] as number;
    await seekTo(renderer, fixture, plan, target);
  }
  const memoryAfter100Seeks = heapUsed();

  renderer.dispose();
  clearContainers();
  await afterFrame();

  return {
    renderer: rendererId,
    fixture: fixture.name,
    eventCount: fixture.events.length,
    firstPaintMs,
    surfaceCreation,
    patchToPaint: summarize(patchSamples),
    seek: summarize(seekSamples),
    replayMs,
    correctness: { finalTextsMatch, reducerIssues: reducer.issues.length },
    suspension: { resumedCorrect, resumeMs },
    memoryAfterLoad,
    memoryAfter100Seeks,
  };
}

async function main(): Promise<void> {
  const renderers: RendererId[] = ["monaco", "codemirror"];
  const configs = benchmarkFixtureConfigs();
  for (const rendererId of renderers) {
    for (const config of configs) {
      progress(`generating ${config.name}`);
      const fixture = generateFixture(config);
      progress(`running ${rendererId} / ${config.name} (${fixture.events.length} events)`);
      try {
        const result = await runFixture(rendererId, fixture);
        post({ type: "bench.result", result });
      } catch (error) {
        post({
          type: "bench.result",
          result: {
            renderer: rendererId,
            fixture: config.name,
            error: String(error instanceof Error ? (error.stack ?? error.message) : error),
          },
        });
      }
    }
  }
  post({ type: "bench.done" });
}

window.addEventListener("message", (event) => {
  const data = event.data as { type?: string };
  if (data?.type === "bench.start") {
    void main();
  }
});

post({ type: "bench.ready" });
