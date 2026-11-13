import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  buildNotebook,
  constantsCell,
  hostedCallDrift,
  hostedEngineDrift,
  hostedVoiceDesignPrompt,
} from "../../../scripts/build-voxcpm2-colab-notebook";
import { MODAL_VOXCPM2_BURMESE_PROFILE } from "../tts/profiles";
import { COLAB_NOTEBOOK_PATH, COLAB_NOTEBOOK_URL } from "./colabNotebook";
import { narrationPackEngineOf } from "./packFormat";

const ROOT = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const HOSTED = read("integrations/modal/voxcpm2_tts.py");

interface Notebook {
  cells: { cell_type: string; source: string[]; metadata: Record<string, unknown> }[];
  nbformat: number;
}

describe("the Colab narration notebook", () => {
  it("is the generator's output", () => {
    // Run: bun scripts/build-voxcpm2-colab-notebook.ts
    expect(read(COLAB_NOTEBOOK_PATH)).toBe(buildNotebook());
  });

  it("opens in Colab from the path it is committed at", () => {
    expect(COLAB_NOTEBOOK_URL).toBe(
      `https://colab.research.google.com/github/channyeintun/next-editor/blob/main/${COLAB_NOTEBOOK_PATH}`,
    );
  });

  it("synthesizes with the engine a request pack names", () => {
    const notebook = JSON.parse(buildNotebook()) as Notebook;
    const code = notebook.cells
      .filter((cell) => cell.cell_type === "code")
      .map((cell) => cell.source.join(""));

    expect(notebook.nbformat).toBe(4);
    // JSON is a Python literal for these values, so the cell holds the pack's engine verbatim.
    expect(code[1]).toContain(
      `ENGINE = ${JSON.stringify(narrationPackEngineOf(MODAL_VOXCPM2_BURMESE_PROFILE), null, 4)}`,
    );
    expect(code[1]).toContain(
      `VOICE_DESIGN_PROMPT = ${JSON.stringify(hostedVoiceDesignPrompt(HOSTED))}`,
    );
    // The batch code is the tested module, whole.
    expect(code[2]).toContain(read("integrations/colab/narration_batch.py").trim());
    // Nothing is left for the generator to fill in, and no cell carries output.
    expect(code.join("\n")).not.toContain("@@");
    expect(read(COLAB_NOTEBOOK_PATH)).not.toContain('"outputs": [\n   {');
  });

  it("speaks in the hosted synthesizer's delivery prompt", () => {
    const prompt = hostedVoiceDesignPrompt(HOSTED);
    expect(prompt).toMatch(/^Speak in the reference recording's own delivery/);
    expect(prompt).toMatch(/never lecturing or reciting$/);
    expect(() => hostedVoiceDesignPrompt('VOICE_DESIGN_PROMPT = "one line"\n')).toThrow(
      "no longer a parenthesized run of plain string literals",
    );
  });

  // The hosted synthesizer keeps its own copy of the engine settings. A take is
  // the one its hash names only while that copy matches the studio's profile.
  it("finds the hosted synthesizer and the studio's profile in agreement", () => {
    expect(hostedEngineDrift(HOSTED)).toEqual([]);
  });

  // The notebook calls VoxCPM itself. A setting the hosted call gains and the
  // notebook's does not would give takes the hosted voice never makes.
  it("loads the model and synthesizes with the hosted synthesizer's own calls", () => {
    expect(hostedCallDrift(HOSTED)).toEqual([]);

    const tuned = HOSTED.replace(
      "inference_timesteps=INFERENCE_TIMESTEPS,",
      "inference_timesteps=INFERENCE_TIMESTEPS,\n                normalize=True,",
    ).replace("optimize=False,", "optimize=True,");
    expect(tuned).not.toBe(HOSTED);
    const drift = hostedCallDrift(tuned);
    expect(drift).toHaveLength(2);
    expect(drift[0]).toMatch(/^generate: hosted \(.*normalize=True\) ≠ notebook/);
    expect(drift[1]).toMatch(/^from_pretrained: hosted \(.*optimize=True\) ≠ notebook/);
    expect(() => constantsCell(tuned)).toThrow("disagree");
  });

  it("refuses to build when they have drifted apart", () => {
    const drifted = HOSTED.replace("INFERENCE_TIMESTEPS = 10", "INFERENCE_TIMESTEPS = 12").replace(
      'VOXCPM_VERSION = "2.0.3"',
      'VOXCPM_VERSION = "2.1.0"',
    );
    expect(hostedEngineDrift(drifted)).toEqual([
      "VOXCPM_VERSION: 2.1.0 ≠ 2.0.3",
      "INFERENCE_TIMESTEPS: 12 ≠ 10",
    ]);
    expect(() => constantsCell(drifted)).toThrow("disagree");
  });
});
