import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";

export const RRWEB_RECORDER_BUNDLE_MODULE_ID = "virtual:rrweb-recorder-bundle";
export const RRWEB_RECORDER_GZIP_BUDGET_BYTES = 56_171;
export const PINNED_RRWEB_RECORD_VERSION = "2.1.0";

const RESOLVED_MODULE_ID = `\0${RRWEB_RECORDER_BUNDLE_MODULE_ID}`;
const require = createRequire(import.meta.url);

export interface RrwebRecorderBundleArtifact {
  code: string;
  gzipBytes: number;
  rawBytes: number;
  version: string;
}

/**
 * Materializes the pinned recorder-only browser IIFE from @rrweb/record. The
 * package's aggregate `rrweb` bundle also contains replay and is intentionally
 * never embedded in preview pages.
 */
export function loadRrwebRecorderBundle(): RrwebRecorderBundleArtifact {
  const packageEntryPath = require.resolve("@rrweb/record");
  const packageRoot = dirname(dirname(packageEntryPath));
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  const version = typeof packageJson.version === "string" ? packageJson.version : "unknown";

  if (version !== PINNED_RRWEB_RECORD_VERSION) {
    throw new Error(
      `Expected @rrweb/record ${PINNED_RRWEB_RECORD_VERSION}, received ${version}. ` +
        "Update the pinned version and recorder size budget together.",
    );
  }

  const bundlePath = join(dirname(packageEntryPath), "record.umd.min.cjs");
  const code = readFileSync(bundlePath, "utf8").replace(
    /\n?\/\/# sourceMappingURL=record\.umd\.min\.cjs\.map\s*$/,
    "",
  );
  const rawBytes = Buffer.byteLength(code);
  const gzipBytes = gzipSync(code, { level: 9 }).byteLength;

  if (!code.includes('g["rrwebRecord"] = f()')) {
    throw new Error("@rrweb/record browser bundle no longer exposes the rrwebRecord global.");
  }
  if (gzipBytes > RRWEB_RECORDER_GZIP_BUDGET_BYTES) {
    throw new Error(
      `Recorder bundle is ${gzipBytes} gzip bytes; budget is ` +
        `${RRWEB_RECORDER_GZIP_BUDGET_BYTES}.`,
    );
  }

  return { code, gzipBytes, rawBytes, version };
}

/** Build-time virtual module: the host carries the recorder IIFE as text and
 * injects it into the offline WebContainer preview realm. */
export function rrwebRecorderBundlePlugin(): Plugin {
  return {
    name: "next-editor-rrweb-recorder-bundle",
    enforce: "pre",
    resolveId(id) {
      return id === RRWEB_RECORDER_BUNDLE_MODULE_ID ? RESOLVED_MODULE_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_MODULE_ID) return null;
      return `export default ${JSON.stringify(loadRrwebRecorderBundle().code)};`;
    },
  };
}
