/**
 * A replay page under bun: the editor machine's real replay actions (through the
 * machine walk in src/core), with host hooks that keep what each panel would show.
 */

import type * as monaco from "monaco-editor";

import type { Recording } from "../../src/core/src";
import type { ChatCheckpoint } from "../../src/core/src/chat";
import type { PreviewState } from "../../src/core/src/preview";
import type { RuntimeRecordingSnapshot } from "../../src/core/src/runtime";
import type { SlidePreviewState } from "../../src/core/src/slides";
import { load, send, type PlaybackMachine } from "../../src/core/src/machine/testing/replayWalk.ts";
import type { EditorMachineEvent } from "../../src/core/src/machine/types";
import type { WhiteboardSceneState } from "../../src/core/src/whiteboard";
import type { WorkspaceRecordingSnapshot } from "../../src/core/src/workspace";

/** The panels a replay drives, each compared on what it shows. */
export const PAGE_TRACKS = [
  "editor",
  "workspace",
  "runtime",
  "chat",
  "whiteboard",
  "slides",
  "preview",
] as const;

export type PageTrack = (typeof PAGE_TRACKS)[number];

export type PageShown = Record<PageTrack, unknown>;

/**
 * A new editor each time, as the app hands over after a model swap. Its model is
 * null, so the frame step folds the frame without writing it anywhere: the frame the
 * machine keeps is what the editor would show.
 */
const stubEditor = () =>
  ({ getModel: () => null }) as unknown as monaco.editor.IStandaloneCodeEditor;

/** The four deck fields the slides panel shows; it keeps a field a state leaves out. */
interface DeckShown {
  isOpen: boolean;
  isMaximized: boolean;
  currentSlideId: string | null;
  indexv: number;
}

interface HostShown {
  workspace: WorkspaceRecordingSnapshot | null;
  sidebarWidth: number;
  previewDockWidth: number;
  runtime?: RuntimeRecordingSnapshot;
  chat?: ChatCheckpoint;
  whiteboard?: WhiteboardSceneState;
  deck: DeckShown;
  preview?: PreviewState;
}

export interface ReplayPage {
  machine: PlaybackMachine;
  /** What each panel shows now. */
  shown(): PageShown;
  /** Sends an event, then the editor handshake the app sends after a file switch. */
  send(event: EditorMachineEvent): void;
  /** Errors the machine reported (a damaged track), in order. */
  errors: string[];
}

/** The open file's text, or undefined for an asset. */
function openFileText(workspace: WorkspaceRecordingSnapshot | null) {
  const file = workspace?.project.files[workspace.activeFilePath];
  return file && "content" in file ? file.content : undefined;
}

/** Every file's text by path (an asset as its kind), with the open project and file. */
function workspaceShown(host: HostShown) {
  const workspace = host.workspace;
  return {
    sidebarWidth: host.sidebarWidth,
    previewDockWidth: host.previewDockWidth,
    project: workspace?.project.id,
    activeFilePath: workspace?.activeFilePath,
    files:
      workspace &&
      Object.fromEntries(
        Object.values(workspace.project.files).map((file) => [
          file.path,
          "content" in file ? file.content : "(asset)",
        ]),
      ),
  };
}

/**
 * The preview panel's state as the panel takes it. Playing applies the interaction of
 * each event it crosses and a seek lands on the state without one, but the panel never
 * reads it (usePreviewPlaybackRegistration.ts), so it is left out.
 */
function previewShown(state: PreviewState | undefined) {
  if (!state) return state;
  const { currentInteraction: _interaction, ...shown } = state;
  return shown;
}

/**
 * Loads `recording` with every host hook at once and the editor ready, and plays
 * it: PLAY, then the editor handshake.
 */
export function openReplayPage(recording: Recording): ReplayPage {
  const host: HostShown = {
    workspace: null,
    sidebarWidth: 0,
    previewDockWidth: 0,
    deck: { isOpen: false, isMaximized: false, currentSlideId: null, indexv: 0 },
  };
  const errors: string[] = [];
  const machine = load({
    recording,
    duration: recording.duration,
    editor: stubEditor(),
    hooks: {
      getWorkspaceSnapshot: () => host.workspace,
      applyWorkspaceSnapshot: (snapshot) => {
        const { sidebarWidthDelta, previewDockWidthDelta, ...files } = snapshot;
        host.workspace = files;
        host.sidebarWidth += sidebarWidthDelta ?? 0;
        host.previewDockWidth += previewDockWidthDelta ?? 0;
      },
      applyRuntimeSnapshot: (snapshot) => (host.runtime = snapshot),
      applyChatSnapshot: (snapshot) => (host.chat = snapshot),
      applyWhiteboardState: (state) => (host.whiteboard = state),
      // As the slides store does (slidesRecordingAdapter.ts): only these four are
      // shown, the slide index is not, and a field left out keeps its value.
      applySlideState: (state: SlidePreviewState) => {
        host.deck = {
          isOpen: state.isOpen,
          isMaximized: state.isMaximized ?? host.deck.isMaximized,
          currentSlideId: state.currentSlideId ?? host.deck.currentSlideId,
          indexv: state.indexv ?? host.deck.indexv,
        };
      },
      applySlides: () => {},
      applyPreviewState: (state) => (host.preview = state),
      // The preview's recorded DOM (rrweb) cannot be replayed without a browser.
      applyPreviewPatchReplay: () => {},
    },
  });
  // A damaged track is reported, not thrown, as in the app; the walk counts it.
  machine.context = {
    ...machine.context,
    onError: (error) => errors.push(error.message),
  };

  const handshake = () => {
    if (!machine.context.pendingPlaybackEditorSync) return;
    send(machine, { type: "SET_EDITOR_REF", editor: stubEditor() });
  };
  const page: ReplayPage = {
    machine,
    errors,
    send: (event) => {
      send(machine, event);
      handshake();
    },
    shown: () => {
      const frame = machine.context.currentFrame;
      return {
        editor: frame
          ? {
              content: frame.state.content,
              selection: frame.state.selection,
              viewState: frame.state.viewState,
            }
          : { frame: null, text: openFileText(host.workspace) },
        workspace: workspaceShown(host),
        runtime: host.runtime,
        chat: host.chat,
        whiteboard: host.whiteboard,
        // A closed deck shows no slide; the store keeps which one for when it reopens.
        slides: host.deck.isOpen ? host.deck : { isOpen: false },
        preview: previewShown(host.preview),
      };
    },
  };
  handshake();
  page.send({ type: "PLAY" });
  return page;
}
