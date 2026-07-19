import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/model/events";
import { benchmarkFixtureConfigs, generateFixture } from "../../src/webview/player/fixtures";
import { SessionReducer } from "../../src/webview/player/SessionReducer";

function reducerFor(fixture: ReturnType<typeof generateFixture>) {
  return new SessionReducer((id) => fixture.checkpointBodies[id]);
}

const smallConfig = () => benchmarkFixtureConfigs().find((config) => config.name === "small")!;

describe("SessionReducer", () => {
  it("replays a fixture to the generator's ground-truth final texts", () => {
    const fixture = generateFixture(smallConfig());
    const reducer = reducerFor(fixture);
    for (const event of fixture.events) {
      reducer.apply(event);
    }
    expect(reducer.issues).toEqual([]);
    for (const documentId of fixture.documentIds) {
      expect(reducer.state.documents.get(documentId)?.text).toBe(fixture.finalTexts[documentId]);
    }
  });

  it("is deterministic across independent runs", () => {
    const fixtureA = generateFixture(smallConfig());
    const fixtureB = generateFixture(smallConfig());
    expect(fixtureA.events.length).toBe(fixtureB.events.length);

    const reducerA = reducerFor(fixtureA);
    const reducerB = reducerFor(fixtureB);
    for (const event of fixtureA.events) {
      reducerA.apply(event);
    }
    for (const event of fixtureB.events) {
      reducerB.apply(event);
    }
    for (const documentId of fixtureA.documentIds) {
      expect(reducerA.state.documents.get(documentId)?.text).toBe(
        reducerB.state.documents.get(documentId)?.text,
      );
    }
    expect(reducerA.state.activeSurfaceId).toBe(reducerB.state.activeSurfaceId);
  });

  it("checkpoint restore + forward patches equals linear prefix replay (seek strategy)", () => {
    const fixture = generateFixture(smallConfig());
    const target = fixture.seekPoints[10]!;

    // Linear truth: apply events 0..target.
    const linear = reducerFor(fixture);
    for (let i = 0; i <= target; i++) {
      linear.apply(fixture.events[i] as SessionEvent);
    }

    // Seek strategy: latest checkpoint per document, then patches forward.
    for (const documentId of fixture.documentIds) {
      let baseText: string | null = null;
      let baseIndex = -1;
      for (let i = 0; i <= target; i++) {
        const event = fixture.events[i] as SessionEvent;
        if (
          event.type === "document.enrolled" &&
          event.payload.descriptor.documentId === documentId
        ) {
          baseText = fixture.checkpointBodies[event.payload.descriptor.initialCheckpointId]!;
          baseIndex = i;
        } else if (
          event.type === "document.checkpoint" &&
          event.payload.documentId === documentId
        ) {
          baseText = fixture.checkpointBodies[event.payload.checkpointId]!;
          baseIndex = i;
        }
      }
      if (baseText === null) {
        continue;
      }
      let text = baseText;
      for (let i = baseIndex + 1; i <= target; i++) {
        const event = fixture.events[i] as SessionEvent;
        if (event.type === "document.patch" && event.payload.documentId === documentId) {
          for (const change of event.payload.changes) {
            text =
              text.slice(0, change.rangeOffsetUtf16) +
              change.text +
              text.slice(change.rangeOffsetUtf16 + change.rangeLengthUtf16);
          }
        }
      }
      expect(text).toBe(linear.state.documents.get(documentId)?.text);
    }
  });

  it("fixture streams satisfy envelope invariants", () => {
    for (const config of benchmarkFixtureConfigs()) {
      if (config.eventCount > 30_000) {
        continue; // keep unit runtime small; large fixtures share the generator
      }
      const fixture = generateFixture(config);
      let lastTUs = -1;
      fixture.events.forEach((event, index) => {
        expect(event.seq).toBe(index);
        expect(event.tUs).toBeGreaterThanOrEqual(lastTUs);
        lastTUs = event.tUs;
      });
    }
  });

  it("large-file fixture initial text is around 5 MiB", () => {
    const config = benchmarkFixtureConfigs().find((c) => c.name === "large-file")!;
    const fixture = generateFixture(config);
    const initial = fixture.checkpointBodies["cp-init-0"]!;
    expect(initial.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(initial.length).toBeLessThan(8 * 1024 * 1024);
  });
});
