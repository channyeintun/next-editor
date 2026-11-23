// The page side of the browser harness (scripts/webnode-harness.ts): a page
// whose driver (test/harnessDriver.ts) boots webnode.
import { WebNode } from "../api";
import { installHarness } from "./harnessDriver";

const query = new URLSearchParams(location.search);

// `?env=NAME=value`, once per variable: what every command the harness runs is
// given (the harness switches the installer's prepared installs off this way),
// without changing the command lines it runs.
const env: Record<string, string> = {};
for (const pair of query.getAll("env")) {
  const at = pair.indexOf("=");
  if (at > 0) {
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }
}

installHarness(() => {
  // A deployment's hosts live under a domain of their own, named in the address.
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
}, env);
