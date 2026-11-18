// What the runtime says it is. One home for the versions and paths `process`,
// `os` and the package installer all report.

/** The engine's own version; also `process.versions.webcontainer`. */
export const WEBNODE_VERSION = "0.1.0";

export const NODE_VERSION = "22.14.0";
export const PLATFORM = "linux";
export const ARCH = "x64";

/** `process.versions`. Packages read `webcontainer` to choose their WebAssembly builds. */
export const VERSIONS: Readonly<Record<string, string>> = {
  node: NODE_VERSION,
  acorn: "8.14.0",
  ada: "2.9.2",
  ares: "1.34.5",
  brotli: "1.1.0",
  cjs_module_lexer: "1.4.1",
  llhttp: "9.2.1",
  modules: "127",
  napi: "10",
  nghttp2: "1.64.0",
  openssl: "3.0.15",
  simdutf: "6.0.3",
  undici: "6.21.1",
  unicode: "16.0",
  uv: "1.49.2",
  uvwasi: "0.0.21",
  v8: "12.4.254.21-node.22",
  zlib: "1.3.0.1-motley-82a5fec",
  webcontainer: WEBNODE_VERSION,
};

export const EXEC_PATH = "/bin/node";
export const HOME_DIR = "/home";
export const TMP_DIR = "/tmp";
export const SHELL_PATH = "/bin/jsh";
export const DEFAULT_PATH = "/bin:/usr/bin:/usr/local/bin";
export const HOSTNAME = "localhost";
export const USERNAME = "user";
/**
 * The one user every process runs as, who owns every file, and that user's
 * group: what `process.getuid()`, `os.userInfo()` and every `stat` report.
 * The shared filesystem's crate writes the same numbers itself
 * (sharedfs/crate/src/fs.rs `UID`, `GID`).
 */
export const UID = 1;
export const GID = 1;
