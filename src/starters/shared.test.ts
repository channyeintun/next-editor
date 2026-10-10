import { describe, expect, it } from "vite-plus/test";

import { WORKSPACE_LESSON_TYPES } from "../types/lessonTypes";
import { isWorkspaceTextFile } from "../types/workspace";
import { createStarterWorkspaceForLessonType } from "./index";
import { createHtmlCssLessonPackageJson, STARTER_VITE_VERSION } from "./shared";

async function packageJsonOf(lessonType: (typeof WORKSPACE_LESSON_TYPES)[number]) {
  const file = (await createStarterWorkspaceForLessonType(lessonType)).files["package.json"];
  return file && isWorkspaceTextFile(file) ? file.content : null;
}

describe("starter package.json", () => {
  it("installs the one STARTER_VITE_VERSION in every starter that uses Vite", async () => {
    // A starter spelling its own range is how the last bump missed a file.
    const strays: string[] = [];
    let viteStarters = 0;
    for (const lessonType of WORKSPACE_LESSON_TYPES) {
      const text = await packageJsonOf(lessonType);
      if (!text) continue;
      const manifest = JSON.parse(text) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const vite = manifest.devDependencies?.vite ?? manifest.dependencies?.vite;
      if (vite === undefined) continue;
      viteStarters += 1;
      if (vite !== STARTER_VITE_VERSION) strays.push(`${lessonType}: ${vite}`);
    }

    // `strays` names the offending starters, so an empty-array diff identifies them.
    expect(strays).toEqual([]);
    // html-css, react, vue, solid, svelte and kite-web.
    expect(viteStarters).toBeGreaterThanOrEqual(6);
  });

  it("writes the html-css manifest with Vite alone and no dependencies key", () => {
    // Built through the SPA builder with no dependencies: JSON.stringify drops
    // the undefined key, so the text a new workspace is seeded with is
    // unchanged from when html-css spelled the manifest out itself.
    expect(createHtmlCssLessonPackageJson()).toBe(`{
  "name": "html-css-lesson",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port 4173",
    "build": "vite build",
    "preview": "vite preview --host 0.0.0.0 --port 4173"
  },
  "devDependencies": {
    "vite": "${STARTER_VITE_VERSION}"
  }
}`);
  });

  it("keeps a framework SPA's keys in manifest order, Vite first among dev tools", async () => {
    const manifest = JSON.parse((await packageJsonOf("vue")) ?? "{}") as Record<string, unknown>;

    expect(Object.keys(manifest)).toEqual([
      "name",
      "private",
      "version",
      "type",
      "scripts",
      "dependencies",
      "devDependencies",
    ]);
    expect(Object.keys(manifest.devDependencies as object)[0]).toBe("vite");
  });
});
