import {
  DEFAULT_WORKSPACE_ENTRY_PATH,
  getParentWorkspacePath,
  joinWorkspacePath,
  normalizeWorkspacePath,
  type WorkspaceProject,
} from "../../types/workspace";

function isLocalWorkspaceAssetPath(path: string): boolean {
  return !/^(?:[a-z]+:|\/\/|#|data:|blob:)/i.test(path);
}

function resolveWorkspaceAssetPath(
  sourcePath: string,
  assetPath: string,
): string {
  if (assetPath.startsWith("/")) {
    return normalizeWorkspacePath(assetPath);
  }

  return joinWorkspacePath(getParentWorkspacePath(sourcePath), assetPath);
}

function getStaticPreviewEntry(project: WorkspaceProject) {
  const configuredEntry = project.files[project.entryFilePath];

  if (configuredEntry?.language === "html") {
    return configuredEntry;
  }

  return (
    project.files[DEFAULT_WORKSPACE_ENTRY_PATH] ??
    Object.values(project.files).find((file) => file.language === "html") ??
    null
  );
}

function supportsStaticWorkspaceScript(
  assetPath: string,
  content: string,
): boolean {
  if (/\.(?:jsx|tsx)$/i.test(assetPath)) {
    return false;
  }

  return !/\b(?:import|export)\b/.test(content);
}

export function createStaticWorkspacePreview(
  project: WorkspaceProject,
): string {
  const entryFile = getStaticPreviewEntry(project);

  if (!entryFile) {
    return "";
  }

  try {
    const parser = new DOMParser();
    const document = parser.parseFromString(entryFile.content, "text/html");

    for (const link of Array.from(
      document.querySelectorAll('link[rel="stylesheet"][href]'),
    )) {
      const href = link.getAttribute("href");

      if (!href || !isLocalWorkspaceAssetPath(href)) {
        continue;
      }

      const assetPath = resolveWorkspaceAssetPath(entryFile.path, href);
      const assetFile = project.files[assetPath];

      if (!assetFile) {
        continue;
      }

      const style = document.createElement("style");
      style.setAttribute("data-source", assetFile.path);
      style.textContent = assetFile.content;
      link.replaceWith(style);
    }

    for (const script of Array.from(document.querySelectorAll("script[src]"))) {
      const src = script.getAttribute("src");

      if (!src || !isLocalWorkspaceAssetPath(src)) {
        continue;
      }

      const assetPath = resolveWorkspaceAssetPath(entryFile.path, src);
      const assetFile = project.files[assetPath];

      if (!assetFile) {
        continue;
      }

      if (!supportsStaticWorkspaceScript(assetFile.path, assetFile.content)) {
        return "";
      }

      const inlineScript = document.createElement("script");

      for (const attribute of Array.from(script.attributes)) {
        if (attribute.name === "src") {
          continue;
        }

        inlineScript.setAttribute(attribute.name, attribute.value);
      }

      inlineScript.textContent = assetFile.content;
      script.replaceWith(inlineScript);
    }

    return `<!doctype html>\n${document.documentElement.outerHTML}`;
  } catch (error) {
    console.warn("Failed to create static workspace preview:", error);

    return "";
  }
}
