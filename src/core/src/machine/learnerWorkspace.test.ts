import { describe, expect, it } from "vite-plus/test";
import { createActor, waitFor } from "xstate";
import { editorMachine } from "./editorMachine";
import type { LearnerWorkspaceSave } from "./learnerWorkspace";
import { createRecording, createWorkspaceSnapshot } from "./testing/takeFixtures";
import type { Recording } from "../types";

describe("editorMachine learner workspace", () => {
  // The viewer's workspace, as NextEditorProvider exposes it: the replay writes it
  // through applyWorkspaceSnapshot, and the viewer edits it directly.
  const setup = async () => {
    let workspace = createWorkspaceSnapshot("outside");
    const saves: LearnerWorkspaceSave[] = [];
    const recording: Recording = {
      ...createRecording(),
      workspaceEvents: [
        { timestamp: 0, snapshot: createWorkspaceSnapshot("recorded-0") },
        { timestamp: 500, snapshot: createWorkspaceSnapshot("recorded-500") },
      ],
    };
    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        getWorkspaceSnapshot: () => workspace,
        applyWorkspaceSnapshot: (snapshot) => {
          workspace = snapshot;
        },
        onLearnerWorkspaceSaved: (save) => {
          saves.push(save);
        },
      },
    }).start();
    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    return {
      actor,
      saves,
      content: () => workspace.project.files["index.html"].content,
      edit: (content: string) => {
        workspace = createWorkspaceSnapshot(content, workspace.sidebarScrollTop);
      },
      look: () => {
        // Scrolling the file tree is not an edit.
        workspace = { ...workspace, sidebarScrollTop: (workspace.sidebarScrollTop ?? 0) + 40 };
      },
    };
  };

  it("keeps the viewer's edits before resuming hands the workspace back", async () => {
    const { actor, saves, content, edit } = await setup();
    actor.send({ type: "PLAY" });
    actor.send({ type: "TICK", currentTime: 600 });
    actor.send({ type: "PAUSE" });
    edit("my version");

    actor.send({ type: "PLAY" });

    expect(saves).toEqual([
      {
        recordingId: "recording-1",
        recordingTime: 600,
        snapshot: createWorkspaceSnapshot("my version"),
      },
    ]);
    expect(actor.getSnapshot().context.hasManualWorkspaceOverride).toBe(false);
    expect(actor.getSnapshot().context.learnerWorkspaceBaseline).toBeNull();
    // The recording owns the workspace again.
    actor.send({ type: "SEEK", time: 0 });
    expect(content()).toBe("recorded-0");
    actor.stop();
  });

  it("saves nothing when the viewer only looked around", async () => {
    const { actor, saves, look } = await setup();
    actor.send({ type: "PLAY" });
    actor.send({ type: "PAUSE" });
    look();

    actor.send({ type: "PLAY" });

    expect(saves).toEqual([]);
    actor.stop();
  });

  it("keeps edits before a paused scrub replaces them", async () => {
    const { actor, saves, content, edit } = await setup();
    actor.send({ type: "PLAY" });
    actor.send({ type: "PAUSE" });
    edit("before scrub");

    actor.send({ type: "SEEK", time: 600 });

    expect(saves.map((save) => save.snapshot.project.files["index.html"].content)).toEqual([
      "before scrub",
    ]);
    expect(content()).toBe("recorded-500");
    // The scrub handed over a fresh baseline: scrubbing again saves nothing new.
    actor.send({ type: "SEEK", time: 0 });
    expect(saves).toHaveLength(1);
    actor.stop();
  });

  it("hands the workspace over at the end and keeps edits made there on replay", async () => {
    const { actor, saves, edit } = await setup();
    actor.send({ type: "PLAY" });
    actor.send({ type: "FINISHED" });
    expect(actor.getSnapshot().context.hasManualWorkspaceOverride).toBe(true);
    edit("after the end");

    actor.send({ type: "PLAY" });

    expect(saves.map((save) => save.snapshot.project.files["index.html"].content)).toEqual([
      "after the end",
    ]);
    expect(actor.getSnapshot().matches({ playback: "playing" })).toBe(true);
    actor.stop();
  });

  // STOP and a restart from the end rewind with resetPlayback, which returns the workspace
  // to the recording outright: the frame is applied at once, without waiting for the
  // playback model to be swapped in, as a resume from the pause does.
  it("keeps edits once and gives the workspace back on STOP", async () => {
    const { actor, saves, content, edit } = await setup();
    actor.send({ type: "PLAY" });
    actor.send({ type: "TICK", currentTime: 600 });
    actor.send({ type: "PAUSE" });
    edit("before stop");

    actor.send({ type: "STOP" });

    expect(saves.map((save) => save.snapshot.project.files["index.html"].content)).toEqual([
      "before stop",
    ]);
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches({ playback: "ready" })).toBe(true);
    expect(snapshot.context.timeline.currentTime).toBe(0);
    expect(snapshot.context.hasManualWorkspaceOverride).toBe(false);
    expect(snapshot.context.learnerWorkspaceBaseline).toBeNull();
    expect(snapshot.context.pendingPlaybackEditorSync).toBe(false);
    expect(content()).toBe("recorded-0");
    actor.stop();
  });

  it("keeps edits once and gives the workspace back on a restart from the end", async () => {
    const { actor, saves, edit } = await setup();
    actor.send({ type: "PLAY" });
    actor.send({ type: "TICK", currentTime: 600 });
    actor.send({ type: "FINISHED" });
    edit("after the end");

    actor.send({ type: "PLAY" });

    expect(saves.map((save) => save.snapshot.project.files["index.html"].content)).toEqual([
      "after the end",
    ]);
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches({ playback: "playing" })).toBe(true);
    expect(snapshot.context.timeline.currentTime).toBe(0);
    expect(snapshot.context.hasManualWorkspaceOverride).toBe(false);
    expect(snapshot.context.learnerWorkspaceBaseline).toBeNull();
    expect(snapshot.context.pendingPlaybackEditorSync).toBe(false);
    actor.stop();
  });

  it("keeps edits made after the end before a scrub replaces them", async () => {
    const { actor, saves, content, edit } = await setup();
    actor.send({ type: "PLAY" });
    // Past the second workspace event, so seeking back to 0 has something to re-apply.
    actor.send({ type: "TICK", currentTime: 600 });
    actor.send({ type: "FINISHED" });
    edit("after the end");

    actor.send({ type: "SEEK", time: 0 });

    expect(saves.map((save) => save.snapshot.project.files["index.html"].content)).toEqual([
      "after the end",
    ]);
    expect(content()).toBe("recorded-0");
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches({ playback: "ended" })).toBe(true);
    // The scrub handed the workspace back to the viewer with a fresh baseline.
    expect(snapshot.context.hasManualWorkspaceOverride).toBe(true);
    expect(snapshot.context.learnerWorkspaceBaseline).not.toBeNull();
    actor.send({ type: "SEEK", time: 600 });
    expect(saves).toHaveLength(1);
    actor.stop();
  });

  it("saves on request without leaving the pause, and only once per change", async () => {
    const { actor, saves, edit } = await setup();
    actor.send({ type: "PLAY" });
    actor.send({ type: "PAUSE" });
    edit("draft");

    actor.send({ type: "PRESERVE_LEARNER_WORKSPACE" });
    actor.send({ type: "PRESERVE_LEARNER_WORKSPACE" });

    expect(saves).toHaveLength(1);
    expect(actor.getSnapshot().matches({ playback: "paused" })).toBe(true);
    // Saving leaves the edits in place, and PLAY does not save them a second time.
    actor.send({ type: "PLAY" });
    expect(saves).toHaveLength(1);
    actor.stop();
  });

  it("restores saved edits at the point they were made, keeping unsaved ones first", async () => {
    const { actor, saves, content, edit } = await setup();
    actor.send({ type: "PLAY" });
    actor.send({ type: "PAUSE" });
    edit("unsaved");

    actor.send({
      type: "RESTORE_LEARNER_WORKSPACE",
      recordingTime: 600,
      snapshot: createWorkspaceSnapshot("saved earlier"),
    });

    const snapshot = actor.getSnapshot();
    expect(snapshot.matches({ playback: "paused" })).toBe(true);
    expect(snapshot.context.timeline.currentTime).toBe(600);
    expect(content()).toBe("saved earlier");
    expect(saves.map((save) => save.snapshot.project.files["index.html"].content)).toEqual([
      "unsaved",
    ]);
    // The restored version is the viewer's again, so resuming keeps it.
    actor.send({ type: "PLAY" });
    expect(saves.at(-1)?.snapshot.project.files["index.html"].content).toBe("saved earlier");
    actor.stop();
  });

  it("restores from playback by pausing first", async () => {
    const { actor, content } = await setup();
    actor.send({ type: "PLAY" });

    actor.send({
      type: "RESTORE_LEARNER_WORKSPACE",
      recordingTime: 100,
      snapshot: createWorkspaceSnapshot("saved earlier"),
    });

    expect(actor.getSnapshot().matches({ playback: "paused" })).toBe(true);
    expect(actor.getSnapshot().context.timeline.currentTime).toBe(100);
    expect(content()).toBe("saved earlier");
    actor.stop();
  });
});
