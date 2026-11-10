import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import {
  applyWhiteboardEvent,
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardElementJSON,
  type WhiteboardEvent,
  type WhiteboardSceneState,
} from "../../whiteboard";
import { createWhiteboardSceneFold } from "./whiteboardSceneFold";

// Few ids and few indices, so events keep replacing, moving, removing and re-adding
// the same elements, and many share an index (or have none, as authored assets do).
const arbUpsert = fc.record(
  {
    id: fc.constantFrom("a", "b", "c", "d", "e", "f"),
    index: fc.constantFrom("a0", "a1", "a2"),
  },
  { requiredKeys: ["id"] },
);

const arbEvent = fc.record(
  {
    upserts: fc.array(arbUpsert, { maxLength: 4 }),
    removedIds: fc.array(fc.constantFrom("a", "b", "c", "d", "e", "f", "missing"), {
      maxLength: 2,
    }),
    view: fc.record({ scrollX: fc.nat({ max: 3 }), scrollY: fc.constant(0), zoom: fc.constant(1) }),
    isOpen: fc.boolean(),
    isMaximized: fc.boolean(),
  },
  { requiredKeys: [] },
);

/** The recorded events: every upsert is its own object, told apart by `version`. */
function record(
  steps: Array<typeof arbEvent extends fc.Arbitrary<infer Step> ? Step : never>,
): WhiteboardEvent[] {
  let version = 0;
  return steps.map(({ upserts, ...step }, index) => ({
    ...step,
    timestamp: index,
    ...(upserts
      ? {
          upserts: upserts.map((upsert): WhiteboardElementJSON => ({
            ...upsert,
            version: (version += 1),
            versionNonce: 1,
            isDeleted: false,
          })),
        }
      : {}),
  }));
}

describe("createWhiteboardSceneFold", () => {
  it("gives, after every event, the scene applyWhiteboardEvent gives", () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 40 }), (steps) => {
        const events = record(steps);
        const fold = createWhiteboardSceneFold(EMPTY_WHITEBOARD_SCENE);
        let expected: WhiteboardSceneState = EMPTY_WHITEBOARD_SCENE;

        for (const event of events) {
          fold.apply(event);
          expected = applyWhiteboardEvent(expected, event);
          expect(fold.scene()).toEqual(expected);
          expect(fold.size()).toBe(expected.elements.length);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("gives the same scene when it is only asked for at the end", () => {
    // Ranks then stand in for every scene in between.
    fc.assert(
      fc.property(
        fc.array(arbEvent, { maxLength: 12 }),
        fc.array(arbEvent, { maxLength: 40 }),
        (prefix, steps) => {
          const events = record([...prefix, ...steps]);
          const start = events
            .slice(0, prefix.length)
            .reduce(applyWhiteboardEvent, EMPTY_WHITEBOARD_SCENE);
          const startElements = [...start.elements];
          const fold = createWhiteboardSceneFold(start);

          for (const event of events.slice(prefix.length)) {
            fold.apply(event);
          }

          expect(fold.scene()).toEqual(events.reduce(applyWhiteboardEvent, EMPTY_WHITEBOARD_SCENE));
          // The scene it started from is someone else's.
          expect(start.elements).toEqual(startElements);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("keeps the elements array across events that do not change the elements", () => {
    const start = applyWhiteboardEvent(EMPTY_WHITEBOARD_SCENE, {
      timestamp: 0,
      upserts: [{ id: "a", version: 1, versionNonce: 1, isDeleted: false }],
    });
    const fold = createWhiteboardSceneFold(start);

    fold.apply({ timestamp: 1, isOpen: true });
    fold.apply({ timestamp: 2, upserts: [], removedIds: [] });

    expect(fold.scene()).toEqual({ ...start, isOpen: true });
    expect(fold.scene().elements).toBe(start.elements);

    // A delta that names an id makes a new array, even when nothing comes of it.
    fold.apply({ timestamp: 3, removedIds: ["missing"] });
    expect(fold.scene().elements).toEqual(start.elements);
    expect(fold.scene().elements).not.toBe(start.elements);
  });
});
