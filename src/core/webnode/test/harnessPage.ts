// The page side of the browser harness (scripts/webnode-harness.ts): a page
// whose driver (test/harnessDriver.ts) boots webnode.
import { WebNode } from "../api";
import { installHarness } from "./harnessDriver";

installHarness(() => {
  // A deployment's hosts live under a domain of their own, named in the address.
  const query = new URLSearchParams(location.search);
  const previewHost = query.get("previewHost");
  return WebNode.boot({
    // `?fs=kernel`: the filesystem inside the kernel worker, to compare with.
    sharedFilesystem: query.get("fs") !== "kernel",
    previewBase: previewHost
      ? { protocol: "https:", host: previewHost }
      : { protocol: location.protocol as "http:" | "https:", host: location.host },
    workdirName: "app",
    forwardPreviewErrors: true,
  });
});
