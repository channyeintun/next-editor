// What the package manager prints, in the voice of the tool that was invoked:
// pnpm's progress line and `Packages: +N` summary, npm's `added N packages`,
// yarn's `[1/4]` steps, bun's `N packages installed`. Text goes to fd 1, and
// warnings and errors to fd 2, through the process runtime.
import { runtime } from "../../runtime";
import type { PmError, PmErrorCode } from "./errors";

/**
 * Returns to the start of the line and clears it, to redraw progress in place.
 * A bare carriage return would do in a terminal, but consoles that drop
 * carriage returns still honour these two control sequences.
 */
const REDRAW_LINE = "\x1b[2K\x1b[1G";

/** The package manager a command was invoked as. */
export type Tool = "npm" | "pnpm" | "yarn" | "bun";

/** The version each tool reports for `--version`. */
export const TOOL_VERSIONS: Readonly<Record<Tool, string>> = {
  npm: "10.9.2",
  pnpm: "9.15.4",
  yarn: "1.22.22",
  bun: "1.2.0",
};

/** Where output goes. */
export interface Sink {
  write(fd: 1 | 2, text: string): void;
  /** True when stdout is a terminal (progress is redrawn in place). */
  readonly isTTY: boolean;
  readonly columns: number;
  /** Resolves once everything written has reached the kernel. */
  flush(): Promise<void>;
}

/** A sink over this process's stdout and stderr. */
export function createRuntimeSink(): Sink {
  const rt = runtime();
  const encoder = new TextEncoder();
  const pending = new Set<Promise<void>>();
  let isTTY = false;
  let columns = 80;
  try {
    isTTY = rt.tty.isatty(1);
    if (isTTY) {
      columns = rt.tty.windowSize(1).columns || 80;
    }
  } catch {
    isTTY = false;
  }
  return {
    isTTY,
    columns,
    write(fd, text) {
      if (text === "") {
        return;
      }
      const bytes = encoder.encode(text);
      let kind: string;
      try {
        kind = rt.fdStream.kind(fd);
      } catch {
        kind = "file";
      }
      if (kind === "pipe" || kind === "tty") {
        const done = new Promise<void>((resolve) => {
          rt.fdStream.write(fd, bytes, () => resolve());
        });
        pending.add(done);
        void done.then(() => pending.delete(done));
        return;
      }
      if (kind === "null") {
        return;
      }
      rt.fs.write(fd, bytes, null);
    },
    async flush() {
      await Promise.all(pending);
    },
  };
}

/** Install progress counters, pnpm's four numbers. */
export interface Counts {
  resolved: number;
  reused: number;
  downloaded: number;
  added: number;
}

/** A top-level dependency for the summary lists. */
export interface DirectDependency {
  name: string;
  version: string;
  type: "prod" | "dev" | "optional" | "peer";
}

export interface InstallSummary {
  added: number;
  removed: number;
  direct: DirectDependency[];
  elapsedMs: number;
}

/** Formats a duration the way pnpm and npm do: `512ms`, `3.2s` (pnpm) or `3s` (npm). */
export function formatDuration(tool: Tool, ms: number): string {
  if (tool === "yarn") {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  if (tool === "bun") {
    return ms < 1000 ? `${ms.toFixed(2)}ms` : `${(ms / 1000).toFixed(2)}s`;
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return tool === "npm" ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

const PNPM_CODES: Record<PmErrorCode, string> = {
  E404: "ERR_PNPM_FETCH_404",
  ETARGET: "ERR_PNPM_NO_MATCHING_VERSION",
  EINTEGRITY: "ERR_PNPM_TARBALL_INTEGRITY",
  EFETCH: "ERR_PNPM_META_FETCH_FAIL",
  EUNSUPPORTED: "ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER",
  EINVALIDPACKAGENAME: "ERR_PNPM_INVALID_PACKAGE_NAME",
  ENOPKG: "ERR_PNPM_NO_PKG_MANIFEST",
  EJSONPARSE: "ERR_PNPM_JSON_PARSE",
  ETAR: "ERR_PNPM_BAD_TARBALL",
  ENOSCRIPT: "ERR_PNPM_NO_SCRIPT",
  ENOCMD: "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL",
  EOTHER: "ERR_PNPM_UNEXPECTED",
};

const NPM_CODES: Partial<Record<PmErrorCode, string>> = {
  E404: "E404",
  ETARGET: "ETARGET",
  EINTEGRITY: "EINTEGRITY",
  EFETCH: "EFETCH",
  EUNSUPPORTED: "EUNSUPPORTEDPROTOCOL",
  EINVALIDPACKAGENAME: "EINVALIDPACKAGENAME",
  ENOPKG: "ENOENT",
  EJSONPARSE: "EJSONPARSE",
  ETAR: "EBADTAR",
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Prints install progress, summaries, warnings and errors for one tool. */
export class Reporter {
  readonly tool: Tool;
  readonly sink: Sink;
  private lastProgress = 0;
  private drewProgress = false;

  constructor(tool: Tool, sink: Sink) {
    this.tool = tool;
    this.sink = sink;
  }

  /** A plain line on stdout. */
  line(text = ""): void {
    this.sink.write(1, `${text}\n`);
  }

  /**
   * Ends a progress line that is being redrawn in place, so that what is
   * printed next starts a line of its own instead of following it.
   */
  private endProgressLine(): void {
    if (this.drewProgress) {
      this.sink.write(1, "\n");
      this.drewProgress = false;
    }
  }

  /** A warning on stderr, in the tool's voice. */
  warn(message: string): void {
    this.endProgressLine();
    const prefix = { pnpm: " WARN  ", npm: "npm warn ", yarn: "warning ", bun: "warn: " }[
      this.tool
    ];
    this.sink.write(2, `${prefix}${message}\n`);
  }

  /** An error on stderr, in the tool's voice. */
  error(error: PmError): void {
    this.endProgressLine();
    const lines: string[] = [];
    if (this.tool === "pnpm") {
      lines.push(` ${PNPM_CODES[error.code]}  ${error.message}`);
      if (error.detail.length > 0) {
        lines.push("", ...error.detail);
      }
    } else if (this.tool === "npm") {
      const code = NPM_CODES[error.code];
      if (code) {
        lines.push(`npm error code ${code}`);
      }
      for (const text of [error.message, ...error.detail]) {
        lines.push(`npm error ${text}`);
      }
    } else if (this.tool === "yarn") {
      lines.push(`error ${error.message}`);
      for (const text of error.detail) {
        lines.push(`info ${text}`);
      }
    } else {
      lines.push(`error: ${error.message}`);
      lines.push(...error.detail);
    }
    this.sink.write(2, `${lines.join("\n")}\n`);
  }

  /** The first lines of an install. */
  installStart(): void {
    if (this.tool === "yarn") {
      this.line(`yarn install v${TOOL_VERSIONS.yarn}`);
      this.line("[1/4] Resolving packages...");
    } else if (this.tool === "bun") {
      this.line(`bun install v${TOOL_VERSIONS.bun}`);
    }
  }

  /** yarn's numbered steps after resolution: 2 fetching, 3 linking, 4 building. */
  step(step: 2 | 3 | 4): void {
    if (this.tool !== "yarn") {
      return;
    }
    const text = {
      2: "Fetching packages...",
      3: "Linking dependencies...",
      4: "Building fresh packages...",
    }[step];
    this.line(`[${step}/4] ${text}`);
  }

  private progressText(counts: Counts): string {
    return `Progress: resolved ${counts.resolved}, reused ${counts.reused}, downloaded ${counts.downloaded}, added ${counts.added}`;
  }

  /** pnpm's progress line, redrawn in place on a terminal (at most every 100 ms). */
  progress(counts: Counts): void {
    if (this.tool !== "pnpm" || !this.sink.isTTY) {
      return;
    }
    const now = Date.now();
    if (now - this.lastProgress < 100) {
      return;
    }
    this.lastProgress = now;
    this.drewProgress = true;
    this.sink.write(1, `${REDRAW_LINE}${this.progressText(counts)}`);
  }

  /** The final progress line. */
  progressDone(counts: Counts): void {
    if (this.tool !== "pnpm") {
      return;
    }
    this.sink.write(
      1,
      `${this.drewProgress ? REDRAW_LINE : ""}${this.progressText(counts)}, done\n`,
    );
    this.drewProgress = false;
  }

  /** The end of an install that changed node_modules. */
  summary(summary: InstallSummary): void {
    const elapsed = formatDuration(this.tool, summary.elapsedMs);
    if (this.tool === "pnpm") {
      const changes = [`+${summary.added}`];
      if (summary.removed > 0) {
        changes.push(`-${summary.removed}`);
      }
      this.line(`Packages: ${changes.join(" ")}`);
      const width = Math.max(1, Math.min(this.sink.columns, 80));
      const total = summary.added + summary.removed;
      const scale = total > width ? width / total : 1;
      const bar = (count: number) => (count > 0 ? Math.max(1, Math.round(count * scale)) : 0);
      const plus = bar(summary.added);
      const minus = bar(summary.removed);
      if (plus + minus > 0) {
        this.line("+".repeat(plus) + "-".repeat(minus));
      }
      for (const [type, title] of [
        ["prod", "dependencies"],
        ["optional", "optionalDependencies"],
        ["dev", "devDependencies"],
      ] as const) {
        const list = summary.direct.filter((dependency) => dependency.type === type);
        if (list.length > 0) {
          this.line();
          this.line(`${title}:`);
          for (const dependency of list) {
            this.line(`+ ${dependency.name} ${dependency.version}`);
          }
        }
      }
      this.line();
      this.line(`Done in ${elapsed}`);
    } else if (this.tool === "npm") {
      const parts: string[] = [];
      if (summary.added > 0) {
        parts.push(`added ${plural(summary.added, "package")}`);
      }
      if (summary.removed > 0) {
        parts.push(`removed ${plural(summary.removed, "package")}`);
      }
      this.line();
      this.line(
        parts.length > 0 ? `${parts.join(", ")} in ${elapsed}` : `up to date in ${elapsed}`,
      );
    } else if (this.tool === "yarn") {
      this.line(`Done in ${elapsed}.`);
    } else {
      this.line();
      for (const dependency of summary.direct) {
        this.line(`+ ${dependency.name}@${dependency.version}`);
      }
      this.line();
      this.line(`${plural(summary.added, "package")} installed [${elapsed}]`);
    }
  }

  /** The end of an install that found nothing to do. */
  upToDate(elapsedMs: number, packages: number): void {
    const elapsed = formatDuration(this.tool, elapsedMs);
    if (this.tool === "pnpm") {
      this.line("Already up to date");
      this.line();
      this.line(`Done in ${elapsed}`);
    } else if (this.tool === "npm") {
      this.line();
      this.line(`up to date in ${elapsed}`);
    } else if (this.tool === "yarn") {
      this.line("success Already up-to-date.");
      this.line(`Done in ${elapsed}.`);
    } else {
      this.line();
      this.line(`Checked ${plural(packages, "install")} (no changes) [${elapsed}]`);
    }
  }
}
