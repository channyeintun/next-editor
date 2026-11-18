// The harness page of measure.ts for StackBlitz's WebContainer: the same
// driver as webnode's page (src/core/webnode/test/harnessPage.ts), booting the
// other engine the way the editor does (src/runtime/webcontainer/engine.ts).
import { WebContainer } from "@webcontainer/api";
import type { WebNode } from "../../src/core/webnode/api";
import { installHarness } from "../../src/core/webnode/test/harnessDriver";

installHarness(
  async () =>
    // The driver uses the part of the API both engines have.
    (await WebContainer.boot({
      coep: "require-corp",
      forwardPreviewErrors: true,
      workdirName: "app",
    })) as unknown as WebNode,
);
