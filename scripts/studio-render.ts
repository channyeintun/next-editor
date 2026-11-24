/**
 * The unattended studio driver (docs/agent-lesson-production.md §12 M2/M3).
 *
 *   bun scripts/studio-render.ts <slug…>              render, as "render <slug…>"
 *   bun scripts/studio-render.ts render|workflow|update|status|login …
 *   bun scripts/studio-render.ts --help               every command and option
 *
 * Drives /studio in system Chrome (playwright-core, no browser download) on a
 * browser profile of its own, kept outside the repository, so a sign-in, the
 * narration cache and the narration settings outlast one command. It works
 * through the studio's automation surface (window.__NEXT_EDITOR_STUDIO__
 * .automation, src/studio/studioWindowHandle.ts) and never clicks, and it
 * exits non-zero unless everything it was asked to do passed.
 *
 * Against a dev server it needs one running (`bun run dev`, and
 * `bun run dev:worker` for anything signed in); it fails fast with that
 * instruction rather than starting servers behind your back.
 */

import { homedir } from "node:os";
import type { Page } from "playwright-core";
import { HELP, parseArgs } from "./studio-driver/args.ts";
import { runLoginCommand, runStatusCommand } from "./studio-driver/accountCommands.ts";
import { DriverError, launchStudioBrowser } from "./studio-driver/browser.ts";
import { runRenderCommand, runUpdateCommand } from "./studio-driver/renderCommand.ts";
import { runWorkflowCommand } from "./studio-driver/workflowCommand.ts";

// Whether a command ran, so its verdict is printed (help and argument errors have none).
let ranCommand = false;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), {
    studioProfile: process.env.STUDIO_PROFILE,
    home: homedir(),
    cwd: process.cwd(),
  });
  if ("error" in parsed) {
    console.error(
      `studio-render: ${parsed.error}\n(bun scripts/studio-render.ts --help lists every command)`,
    );
    return 2;
  }
  const { command } = parsed;
  if (command.kind === "help") {
    console.log(HELP);
    return 0;
  }
  ranCommand = true;
  // login launches its own browser, after the person's Chrome has closed.
  if (command.kind === "login") return (await runLoginCommand(command)) ? 0 : 1;

  console.log(
    `studio-render: ${command.kind} on ${command.shared.url} with the profile ${command.shared.profile}`,
  );
  const context = await launchStudioBrowser(command.shared);
  context.on("page", (page) => watchPage(page));
  for (const page of context.pages()) watchPage(page);
  try {
    switch (command.kind) {
      case "status":
        return (await runStatusCommand(context, command)) ? 0 : 1;
      case "render":
        return (await runRenderCommand(context, command)) ? 0 : 1;
      case "workflow":
        return (await runWorkflowCommand(context, command)) ? 0 : 1;
      case "update":
        return (await runUpdateCommand(context, command)) ? 0 : 1;
    }
  } finally {
    await context.close().catch(() => {});
  }
}

function watchPage(page: Page): void {
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`  [page:error] ${message.text().slice(0, 300)}`);
  });
}

let exitCode: number;
try {
  exitCode = await main();
} catch (error) {
  console.error(
    `studio-render: ${error instanceof DriverError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  exitCode = 1;
}
if (ranCommand) console.log(exitCode === 0 ? "studio-render: PASS" : "studio-render: FAIL");
process.exit(exitCode);
