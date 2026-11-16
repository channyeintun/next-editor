// The runtime frame's script. The frame is a hidden iframe on the runtime
// origin, so the kernel worker it starts, and every process worker the kernel
// starts, run on an origin that holds nothing of the editor's. It gives the
// editor one MessagePort to the kernel and takes no further part.
import { servedEditorOrigin } from "../preview/connectPage";

const editorOrigin = servedEditorOrigin();

if (window.parent !== window) {
  const kernel = new Worker("/__webnode__/kernel.js", { name: "webnode kernel" });
  const channel = new MessageChannel();
  kernel.postMessage({ type: "connect" }, [channel.port2]);
  // Only the editor this frame was served for receives the port.
  window.parent.postMessage({ type: "webnode:runtime-ready" }, editorOrigin, [channel.port1]);
  kernel.addEventListener("error", (event) => {
    window.parent.postMessage(
      {
        type: "webnode:runtime-error",
        message: event.message || "the kernel worker failed to start",
      },
      editorOrigin,
    );
  });
}
