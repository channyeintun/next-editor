/**
 * Regenerate the distributable `share/lesson-script-skill/` bundle from the
 * canonical in-repo sources instead of hand-maintaining a fork (SKILL-01):
 *
 *   docs/lesson-script-authoring.md  → references/lesson-script-authoring.md
 *   docs/studio-persona.md           → references/studio-persona.md
 *   src/studio/scripts/rust-borrow.yaml → examples/rust-borrow.yaml
 *
 * Only a small, fixed set of framing edits differ (the bundle drops repo/CLI
 * specifics for the nexteditor.dev/studio website toolchain); every normative
 * section — schema, runtime matrix, action catalog, fixtures, failure table —
 * is copied verbatim. Each edit asserts its anchor is present and unique, so a
 * canonical change that moves an anchor fails loudly here rather than silently
 * leaving stale (forked) text behind. `share/lesson-script-skill/bundle.test.ts`
 * fails when the checked-in bundle drifts from this generator's output or from
 * the schema.
 *
 *   bun scripts/build-lesson-script-skill.ts            # write the bundle
 *   bun scripts/build-lesson-script-skill.ts --check    # verify it is current
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

function replaceOnce(text: string, marker: string, replacement: string): string {
  const index = text.indexOf(marker);
  if (index === -1) {
    throw new Error(
      `build-lesson-script-skill: anchor not found (update the generator):\n${marker.slice(0, 160)}…`,
    );
  }
  if (text.indexOf(marker, index + marker.length) !== -1) {
    throw new Error(
      `build-lesson-script-skill: anchor is not unique (update the generator):\n${marker.slice(0, 160)}…`,
    );
  }
  return text.slice(0, index) + replacement + text.slice(index + marker.length);
}

/** Join lines with "\n" so code-fence blocks avoid backtick-escaping headaches. */
const lines = (...parts: string[]): string => parts.join("\n");

export function buildReference(canonical: string): string {
  let out = canonical;

  // T1 — intro: website framing, drop the in-repo runbook link.
  out = replaceOnce(
    out,
    lines(
      "Written for **agents** (Claude Code, Codex, or any coding agent) as much as for",
      "humans: following this document end-to-end produces a lesson that compiles,",
      "renders unattended, and passes every mechanical gate — without reading the",
      "studio's source code. The editorial rules live in",
      "[studio-persona.md](./studio-persona.md); the operational runbook in",
      "[studio-m0-runbook.md](./studio-m0-runbook.md).",
    ),
    lines(
      "Written for any agent (Claude, Codex, Cursor, …) as much as for humans:",
      "following this document end-to-end produces a lesson that compiles, renders",
      "unattended, and passes every mechanical gate. The editorial rules live in",
      "[studio-persona.md](./studio-persona.md). No repository or CLI is needed —",
      "https://nexteditor.dev/studio is the whole toolchain.",
    ),
  );

  // T2 — "What you are producing": the file reaches the studio by website import.
  out = replaceOnce(
    out,
    lines(
      "browser at render time. Two ways it reaches the studio:",
      "",
      "- **Checked in** at `src/studio/scripts/<slug>.yaml` — auto-registers by",
      "  filename (never touch `src/studio/plans/index.ts`).",
      "- **Imported at runtime** — any user pastes the file into `/studio` on the",
      "  website via **Import…**; it is validated and critiqued in the page.",
    ),
    lines(
      "browser at render time: open https://nexteditor.dev/studio, click",
      "**Import…**, and pick the file — it is validated and critiqued in the page.",
    ),
  );

  // T3 — voiceProfile comment: no in-repo source path.
  out = replaceOnce(
    out,
    "  voiceProfile: pocket-alba-v1 # see src/studio/tts/profiles.ts for ids",
    "  voiceProfile: pocket-alba-v1 # the built-in narrator voice",
  );

  // T4 — Workflow: replace the in-repo agent CLI procedure with the website one.
  out = replaceOnce(
    out,
    lines(
      "**Agents working in this repo**:",
      "",
      "```text",
      "1. Write    src/studio/scripts/<slug>.yaml     # auto-registers by filename",
      "2. Validate bun scripts/studio-director.ts     # optional preflight, all scripts",
      "                                               # (or pass one path)",
      "   → fix schema/marker errors; weigh critic notes (advisory);",
      "     writes <slug>.critique.json next to the YAML",
      "3. Render   bun run dev   (separate terminal, keep running)",
      "            open /studio?plan=<slug> in a real Chrome, press Start render,",
      '            watch the performance, confirm "Checks (N/N ok)" + receipts',
      "   → agents with browser access drive the user's Chrome and watch live;",
      "     do not verify with the headless harness",
      "     (bun scripts/studio-render.ts exists for CI/repeatability audits only)",
      "   → for a JS/TS preview fixture, repeat from a clean page and require both",
      "     renders to pass normalized repeatability before claiming support",
      "4. A human watches the full replay (/studio?plan=<slug>) and decides on a draft.",
      "```",
      "",
      "Step 2 is convenience — the same validation runs in the page — but it catches",
      "errors without a browser. Renders need Chrome and network for the one-time",
      "TTS bundle download and, for JS/TS, the pinned dependency install. If your",
      "environment cannot run a browser, stop after step 2 and report that the two",
      "Chrome renders and human replay review are pending.",
    ),
    lines(
      "**Workflow for authors and agents**:",
      "",
      "```text",
      "1. Write   <slug>.yaml            # anywhere on disk; the YAML is the artifact",
      "2. Import  nexteditor.dev/studio  # Import… validates + critiques in the page",
      "   → fix every schema/marker error; fix critic notes of the kinds",
      "     sources.missing, banned phrases, and register.read-aloud",
      "3. Render  press Start render, watch the performance,",
      '           confirm "Checks (N/N ok)" in the panel',
      "4. A human watches the lesson and decides on Create draft… (sign-in).",
      "```",
    ),
  );

  // T5 — Google decks resolve during the render build in the page, not on import
  // and not via a CLI. (The forked bundle wrongly claimed the import step verified
  // page ids.)
  out = replaceOnce(
    out,
    lines(
      "SVG into the plan; `bun scripts/studio-director.ts` verifies the page ids",
      "early (best-effort — offline it warns and the render page re-checks):",
    ),
    lines(
      "SVG into the plan; the deck page ids resolve during the render build in the",
      "page (a mismatch lists the valid ids), so keep them current:",
    ),
  );

  // T6 — "A complete example": point at the bundled example, not repo paths.
  out = replaceOnce(
    out,
    lines(
      "`src/studio/scripts/rust-borrow.yaml` is the canonical example: eight scenes,",
      "published-deck slides, keystroke and line-by-line typing, run + gates, in the",
      "conversational persona register. Start from a copy of it. Smaller historical",
      "pilots (Go, incl. whiteboard + retry-fixture usage) live as test fixtures",
      "under `src/studio/script/__fixtures__/`.",
      "",
      "JavaScript/TypeScript regression fixtures live beside those pilots:",
      "[`javascript-minimal.yaml`](../src/studio/script/__fixtures__/javascript-minimal.yaml)",
      "checks the required JavaScript contract, while",
      "[`typescript-vite-preview.yaml`](../src/studio/script/__fixtures__/typescript-vite-preview.yaml)",
      "is the preview qualification case. Import the latter into `/studio` for its",
      "two clean real-Chrome renders. Compilation or headless CI alone does not lift",
      "the release-candidate gate; record both repeatability passes and complete the",
      "human replay review first.",
    ),
    lines(
      "`examples/rust-borrow.yaml` (bundled beside this document) is the canonical",
      "example: eight scenes, published-deck slides, keystroke and line-by-line",
      "typing, run + gates, in the conversational persona register. Start from a copy",
      "of it.",
    ),
  );

  return out;
}

export function buildPersona(canonical: string): string {
  // The only fork surface is the intro's in-repo pointers.
  return replaceOnce(
    canonical,
    lines(
      "The versioned editorial contract for studio-produced lessons",
      "([agent-lesson-production.md](./agent-lesson-production.md) §8). Scripts are the",
      "highest-leverage artifact; this guide is what the advisory critic",
      "(`src/studio/script/critic.ts`, same version number) lints against and what human",
      "reviewers judge drafts by. Changes bump the version here and in the critic",
      "together.",
    ),
    lines(
      "The versioned editorial contract for studio-produced lessons. Scripts are",
      "the highest-leverage artifact; this guide is what the studio's advisory",
      "critic lints against (on import at nexteditor.dev/studio) and what human",
      "reviewers judge drafts by.",
    ),
  );
}

export interface BundleArtifact {
  path: string;
  content: string;
}

/** The generated bundle artifacts, derived purely from the canonical sources. */
export function buildBundle(): BundleArtifact[] {
  const canonicalReference = readFileSync(resolve(ROOT, "docs/lesson-script-authoring.md"), "utf8");
  const canonicalPersona = readFileSync(resolve(ROOT, "docs/studio-persona.md"), "utf8");
  const exampleYaml = readFileSync(resolve(ROOT, "src/studio/scripts/rust-borrow.yaml"), "utf8");

  return [
    {
      path: "share/lesson-script-skill/references/lesson-script-authoring.md",
      content: buildReference(canonicalReference),
    },
    {
      path: "share/lesson-script-skill/references/studio-persona.md",
      content: buildPersona(canonicalPersona),
    },
    { path: "share/lesson-script-skill/examples/rust-borrow.yaml", content: exampleYaml },
  ];
}

// CLI: write the bundle, or (with --check) verify it is current and exit non-zero
// if not. The test harness imports buildBundle directly, so this block only runs
// when the file is executed as a script.
if (import.meta.main) {
  const check = process.argv.includes("--check");
  let drifted = false;
  for (const artifact of buildBundle()) {
    const absolute = resolve(ROOT, artifact.path);
    if (check) {
      const current = readFileSync(absolute, "utf8");
      if (current !== artifact.content) {
        drifted = true;
        console.error(`build-lesson-script-skill: OUT OF DATE ${artifact.path}`);
      }
    } else {
      writeFileSync(absolute, artifact.content);
      console.log(`build-lesson-script-skill: wrote ${artifact.path}`);
    }
  }
  if (check && drifted) {
    console.error("Run: bun scripts/build-lesson-script-skill.ts");
    process.exit(1);
  }
  if (check) {
    console.log("build-lesson-script-skill: bundle is current");
  }
}
