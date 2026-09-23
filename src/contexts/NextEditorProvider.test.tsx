import { act, render } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextEditorProvider } from "./NextEditorProvider";
import { NextEditorActorContext } from "./NextEditorActorContext";
import {
  PreviewAdapterHandleProvider,
  usePreviewAdapterHandle,
} from "./PreviewAdapterHandleContext";
import { RuntimePanelStoreProvider } from "./RuntimePanelStoreContext";
import { SlidesStoreProvider } from "./SlidesStoreContext";
import { WebContainerRuntimeProvider } from "./WebContainerRuntimeProviderImpl";
import { WhiteboardStoreProvider } from "./WhiteboardStoreContext";
import { WorkspaceProvider } from "./WorkspaceProvider";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import type { NextEditorActions } from "./NextEditorContext";
import type { EditorActorRef } from "../core/src/useNextEditor";
import type { PreviewAdapterHandle } from "../stores/previewAdapterHandle";

/** The providers Editor.tsx wraps NextEditorProvider in, minus collaboration and UI. */
function EditorProviders({ children }: PropsWithChildren) {
  return (
    <WorkspaceProvider>
      <WebContainerRuntimeProvider allowAmbientStart={false}>
        <SlidesStoreProvider>
          <WhiteboardStoreProvider>
            <RuntimePanelStoreProvider>
              <PreviewAdapterHandleProvider>
                <NextEditorProvider>{children}</NextEditorProvider>
              </PreviewAdapterHandleProvider>
            </RuntimePanelStoreProvider>
          </WhiteboardStoreProvider>
        </SlidesStoreProvider>
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>
  );
}

function renderNextEditorProvider() {
  const captured: {
    actions: NextEditorActions | null;
    actor: EditorActorRef | null;
    previewHandle: PreviewAdapterHandle | null;
  } = { actions: null, actor: null, previewHandle: null };

  function Capture() {
    captured.actions = useNextEditorActions();
    captured.actor = NextEditorActorContext.useActorRef();
    captured.previewHandle = usePreviewAdapterHandle();
    return null;
  }

  render(
    <EditorProviders>
      <Capture />
    </EditorProviders>,
  );

  const { actions, actor, previewHandle } = captured;
  if (!actions || !actor || !previewHandle) throw new Error("Expected the providers to render");
  const send = vi.spyOn(actor, "send");
  const stopRecordingSends = () =>
    send.mock.calls.filter(([event]) => event.type === "STOP_RECORDING").length;
  return { actions, previewHandle, stopRecordingSends };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NextEditorProvider stopRecording", () => {
  // The preview flushes its last rrweb batch before the take stops, and every
  // stop control (button, shortcut, collaboration handoff) may fire at once.
  it("shares one stop across concurrent calls and stops once the preview is ready", async () => {
    const { actions, previewHandle, stopRecordingSends } = renderNextEditorProvider();
    let finishPreparing: () => void = () => {};
    const prepare = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          finishPreparing = resolve;
        }),
    );
    previewHandle.recordingStopPreparer.current = prepare;

    const first = actions.stopRecording();
    const second = actions.stopRecording();

    expect(second).toBe(first);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(stopRecordingSends()).toBe(0);

    await act(async () => {
      finishPreparing();
      await first;
    });

    expect(stopRecordingSends()).toBe(1);
  });

  it("still stops when the preview fails to prepare, and the next call starts afresh", async () => {
    const { actions, previewHandle, stopRecordingSends } = renderNextEditorProvider();
    previewHandle.recordingStopPreparer.current = () =>
      Promise.reject(new Error("preview flush failed"));

    const failed = actions.stopRecording();
    await act(async () => {
      await expect(failed).rejects.toThrow("preview flush failed");
    });
    expect(stopRecordingSends()).toBe(1);

    previewHandle.recordingStopPreparer.current = null;
    const retried = actions.stopRecording();
    expect(retried).not.toBe(failed);
    await act(async () => {
      await retried;
    });
    expect(stopRecordingSends()).toBe(2);
  });
});
