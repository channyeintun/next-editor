/**
 * Build the Colab notebook that synthesizes a narration request pack
 * (integrations/colab/voxcpm2_narration.ipynb) from its sources, instead of
 * keeping a notebook by hand:
 *
 *   integrations/colab/voxcpm2_narration.py   the cells, one "# %%" block each
 *   integrations/colab/narration_batch.py     the batch code, tested without a GPU
 *   src/studio/tts/profiles.ts                the engine a take's hash names
 *   src/studio/tts/voxcpm2Protocol.ts         the request limits
 *   integrations/modal/voxcpm2_tts.py         the delivery prompt, pinned there
 *
 * The notebook must synthesize exactly what the studio hashed, so its engine
 * settings are the ones the request pack carries (narrationPackEngineOf) and
 * its prompt is the hosted synthesizer's. The hosted synthesizer keeps its own
 * copy of the engine settings, and the notebook its own copy of the two calls
 * into VoxCPM; the build fails if either pair has drifted apart, since a take
 * could then not be the one its hash names. src/studio/narrationPack/colabNotebook.test.ts fails when the
 * committed notebook is not this build's output.
 *
 *   bun scripts/build-voxcpm2-colab-notebook.ts            # write the notebook
 *   bun scripts/build-voxcpm2-colab-notebook.ts --check    # verify it is current
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { COLAB_NOTEBOOK_PATH } from "../src/studio/narrationPack/colabNotebook";
import { narrationPackEngineOf } from "../src/studio/narrationPack/packFormat";
import { MODAL_VOXCPM2_BURMESE_PROFILE } from "../src/studio/tts/profiles";
import {
  VOXCPM2_MAX_REFERENCE_SECONDS,
  VOXCPM2_MAX_SEED,
  VOXCPM2_MAX_TEXT_CHARS,
  VOXCPM2_MIN_REFERENCE_SECONDS,
  VOXCPM2_REFERENCE_SAMPLE_RATE,
} from "../src/studio/tts/voxcpm2Protocol";

const ROOT = resolve(__dirname, "..");
const CELLS_PATH = "integrations/colab/voxcpm2_narration.py";
const BATCH_PATH = "integrations/colab/narration_batch.py";
const HOSTED_PATH = "integrations/modal/voxcpm2_tts.py";

const CONSTANTS_MARKER = "# @@GENERATED_CONSTANTS@@";
const BATCH_MARKER = "# @@NARRATION_BATCH@@";

const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

/** One `NAME = <literal>` assignment of the hosted synthesizer, as written. */
function hostedLiteral(source: string, name: string): string {
  const match = new RegExp(`^${name} = (.+)$`, "m").exec(source);
  if (!match) {
    throw new Error(`build-voxcpm2-colab-notebook: ${HOSTED_PATH} no longer assigns ${name}`);
  }
  return match[1].trim();
}

/** A Python int or float literal such as 48_000, 2.0 or 0x7FFFFFFF. */
function hostedNumber(source: string, name: string): number {
  const value = Number(hostedLiteral(source, name).replaceAll("_", ""));
  if (!Number.isFinite(value)) {
    throw new Error(`build-voxcpm2-colab-notebook: ${name} in ${HOSTED_PATH} is not a number`);
  }
  return value;
}

function hostedString(source: string, name: string): string {
  const literal = hostedLiteral(source, name);
  if (!/^"[^"\\]*"$/.test(literal)) {
    throw new Error(
      `build-voxcpm2-colab-notebook: ${name} in ${HOSTED_PATH} is not a plain string`,
    );
  }
  return literal.slice(1, -1);
}

/** The delivery prompt: adjacent plain string literals in parentheses. */
export function hostedVoiceDesignPrompt(source: string): string {
  const block = /^VOICE_DESIGN_PROMPT = \(\n((?: {4}"[^"\\\n]*"\n)+)\)$/m.exec(source);
  if (!block) {
    throw new Error(
      `build-voxcpm2-colab-notebook: VOICE_DESIGN_PROMPT in ${HOSTED_PATH} is no longer a parenthesized run of plain string literals (update the generator)`,
    );
  }
  return [...block[1].matchAll(/"([^"\\\n]*)"/g)].map((part) => part[1]).join("");
}

/**
 * Where the hosted synthesizer's own engine settings differ from the studio
 * profile's, as `name: hosted ≠ profile` lines. Empty when they agree.
 */
export function hostedEngineDrift(source: string = read(HOSTED_PATH)): string[] {
  const profile = MODAL_VOXCPM2_BURMESE_PROFILE;
  const pairs: [string, unknown, unknown][] = [
    ["MODEL_ID", hostedString(source, "MODEL_ID"), profile.model],
    ["MODEL_REVISION", hostedString(source, "MODEL_REVISION"), profile.modelRevision],
    ["VOXCPM_VERSION", hostedString(source, "VOXCPM_VERSION"), profile.packageVersion],
    ["SAMPLE_RATE", hostedNumber(source, "SAMPLE_RATE"), profile.sampleRate],
    ["CFG_VALUE", hostedNumber(source, "CFG_VALUE"), profile.cfgValue],
    [
      "INFERENCE_TIMESTEPS",
      hostedNumber(source, "INFERENCE_TIMESTEPS"),
      profile.inferenceTimesteps,
    ],
    ["MAX_TEXT_CHARS", hostedNumber(source, "MAX_TEXT_CHARS"), VOXCPM2_MAX_TEXT_CHARS],
    ["MAX_SEED", hostedNumber(source, "MAX_SEED"), VOXCPM2_MAX_SEED],
    [
      "REFERENCE_SAMPLE_RATE",
      hostedNumber(source, "REFERENCE_SAMPLE_RATE"),
      VOXCPM2_REFERENCE_SAMPLE_RATE,
    ],
    [
      "MIN_REFERENCE_SECONDS",
      hostedNumber(source, "MIN_REFERENCE_SECONDS"),
      VOXCPM2_MIN_REFERENCE_SECONDS,
    ],
    [
      "MAX_REFERENCE_SECONDS",
      hostedNumber(source, "MAX_REFERENCE_SECONDS"),
      VOXCPM2_MAX_REFERENCE_SECONDS,
    ],
  ];
  return pairs
    .filter(([, hosted, studio]) => hosted !== studio)
    .map(([name, hosted, studio]) => `${name}: ${String(hosted)} ≠ ${String(studio)}`);
}

/** The arguments of the one call to `callee(` in a Python source, on one line. */
function callArguments(source: string, callee: string, path: string): string {
  const calls = [
    ...source.matchAll(
      new RegExp(`${callee.replaceAll(".", "\\.")}\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, "g"),
    ),
  ];
  if (calls.length !== 1) {
    throw new Error(
      `build-voxcpm2-colab-notebook: expected one ${callee}( call in ${path}, found ${calls.length} (update the generator)`,
    );
  }
  return calls[0][1].replace(/\s+/g, " ").replace(/,\s*$/, "").trim();
}

/**
 * Where the notebook's two calls into VoxCPM (loading the model, synthesizing a
 * dialog) differ from the hosted synthesizer's, once the names each side gives
 * the same value are made one. Empty when they are the same calls: a setting
 * added to one side only would give takes the hosted voice never makes, under
 * its hashes.
 */
export function hostedCallDrift(
  hosted: string = read(HOSTED_PATH),
  batch: string = read(BATCH_PATH),
  cells: string = read(CELLS_PATH),
): string[] {
  const sameNames = (call: string) =>
    call
      .replace("{VOICE_DESIGN_PROMPT}", "{prompt}")
      .replace("{dialog.text}", "{text}")
      .replace("reference_file.name", "reference_path")
      .replace('float(engine["cfgValue"])', "CFG_VALUE")
      .replace('int(engine["inferenceTimesteps"])', "INFERENCE_TIMESTEPS");
  const pairs: [string, string, string][] = [
    [
      "generate",
      sameNames(callArguments(hosted, "self.model.generate", HOSTED_PATH)),
      sameNames(callArguments(batch, "model.generate", BATCH_PATH)),
    ],
    [
      "from_pretrained",
      callArguments(hosted, "VoxCPM.from_pretrained", HOSTED_PATH),
      callArguments(cells, "VoxCPM.from_pretrained", CELLS_PATH),
    ],
  ];
  return pairs
    .filter(([, hostedCall, notebookCall]) => hostedCall !== notebookCall)
    .map(
      ([name, hostedCall, notebookCall]) =>
        `${name}: hosted (${hostedCall}) ≠ notebook (${notebookCall})`,
    );
}

/** JSON is a Python literal here: strings, numbers, and flat objects of them only. */
const python = (value: unknown) => JSON.stringify(value, null, 4);

/** The cell that states what this notebook synthesizes with. */
export function constantsCell(hosted: string = read(HOSTED_PATH)): string {
  const drift = [...hostedEngineDrift(hosted), ...hostedCallDrift(hosted)];
  if (drift.length > 0) {
    throw new Error(
      `build-voxcpm2-colab-notebook: ${HOSTED_PATH} and the studio's VoxCPM2 profile disagree, so a take could not be the one its hash names — ${drift.join("; ")}`,
    );
  }
  return [
    "# What this notebook synthesizes with. A request pack names the same engine, and",
    "# load_pack refuses one that does not: its takes would not be the ones its hashes name.",
    `ENGINE = ${python(narrationPackEngineOf(MODAL_VOXCPM2_BURMESE_PROFILE))}`,
    `LIMITS = ${python({
      maxTextChars: VOXCPM2_MAX_TEXT_CHARS,
      maxSeed: VOXCPM2_MAX_SEED,
      referenceSampleRate: VOXCPM2_REFERENCE_SAMPLE_RATE,
      minReferenceSeconds: VOXCPM2_MIN_REFERENCE_SECONDS,
      maxReferenceSeconds: VOXCPM2_MAX_REFERENCE_SECONDS,
    })}`,
    "# The delivery every dialog is spoken in, as the hosted synthesizer pins it.",
    `VOICE_DESIGN_PROMPT = ${python(hostedVoiceDesignPrompt(hosted))}`,
  ].join("\n");
}

interface NotebookCell {
  cell_type: "markdown" | "code";
  metadata: Record<string, unknown>;
  source: string[];
  execution_count?: null;
  outputs?: [];
}

/** A cell's text as the notebook format keeps it: lines that keep their newline, but the last. */
function sourceLines(text: string): string[] {
  const lines = text.replace(/^\n+|\n+$/g, "").split("\n");
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line));
}

function replaceMarker(text: string, marker: string, replacement: string): string {
  const parts = text.split(marker);
  if (parts.length !== 2) {
    throw new Error(`build-voxcpm2-colab-notebook: ${CELLS_PATH} must hold ${marker} exactly once`);
  }
  return parts.join(replacement);
}

export function buildNotebook(): string {
  const cellsSource = replaceMarker(
    replaceMarker(read(CELLS_PATH), CONSTANTS_MARKER, constantsCell()),
    BATCH_MARKER,
    read(BATCH_PATH).trim(),
  );
  // Everything before the first "# %%" is a note to whoever edits the source.
  const blocks = cellsSource.split(/^# %%/m).slice(1);
  const cells: NotebookCell[] = blocks.map((block) => {
    const newline = block.indexOf("\n");
    const header = block.slice(0, newline).trim();
    const body = block.slice(newline + 1);
    if (header === "[markdown]") {
      return {
        cell_type: "markdown",
        metadata: {},
        source: sourceLines(body.replace(/^# ?/gm, "")),
      };
    }
    if (header !== "") {
      throw new Error(`build-voxcpm2-colab-notebook: unknown cell kind "# %% ${header}"`);
    }
    // Colab shows a titled cell as its form, with the code folded away.
    const form = /^#@title .*display-mode: "form"/.test(body.trimStart());
    return {
      cell_type: "code",
      execution_count: null,
      metadata: form ? { cellView: "form" } : {},
      outputs: [],
      source: sourceLines(body),
    };
  });
  const notebook = {
    cells,
    metadata: {
      accelerator: "GPU",
      colab: { gpuType: "T4", provenance: [] },
      kernelspec: { display_name: "Python 3", name: "python3" },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 0,
  };
  return `${JSON.stringify(notebook, null, 1)}\n`;
}

// CLI: write the notebook, or (with --check) verify it is current and exit
// non-zero if not. The test imports buildNotebook directly.
if (import.meta.main) {
  const absolute = resolve(ROOT, COLAB_NOTEBOOK_PATH);
  const notebook = buildNotebook();
  if (process.argv.includes("--check")) {
    if (readFileSync(absolute, "utf8") !== notebook) {
      console.error(`build-voxcpm2-colab-notebook: OUT OF DATE ${COLAB_NOTEBOOK_PATH}`);
      console.error("Run: bun scripts/build-voxcpm2-colab-notebook.ts");
      process.exit(1);
    }
    console.log(`build-voxcpm2-colab-notebook: ${COLAB_NOTEBOOK_PATH} is current`);
  } else {
    writeFileSync(absolute, notebook);
    console.log(`build-voxcpm2-colab-notebook: wrote ${COLAB_NOTEBOOK_PATH}`);
  }
}
