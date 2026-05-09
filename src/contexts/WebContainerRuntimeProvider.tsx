import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
  type WebContainerRuntimeStatus,
} from "./WebContainerRuntimeContext";

interface WebContainerRuntimeProviderProps {
  children: React.ReactNode;
}

const starterProjectFiles: FileSystemTree = {
  "package.json": {
    file: {
      contents: JSON.stringify(
        {
          name: "next-editor-webcontainer-starter",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: {
            dev: "vite --host 0.0.0.0 --port 4173",
            build: "vite build",
            preview: "vite preview --host 0.0.0.0 --port 4173",
          },
          dependencies: {
            react: "^19.2.0",
            "react-dom": "^19.2.0",
          },
          devDependencies: {
            "@vitejs/plugin-react": "^6.0.1",
            vite: "^8.0.11",
          },
        },
        null,
        2,
      ),
    },
  },
  "index.html": {
    file: {
      contents: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Next Editor Starter</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`,
    },
  },
  "vite.config.js": {
    file: {
      contents: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});`,
    },
  },
  src: {
    directory: {
      "main.jsx": {
        file: {
          contents: `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);`,
        },
      },
      "App.jsx": {
        file: {
          contents: `export default function App() {
  return (
    <main className="app-shell">
      <p className="eyebrow">WebContainer Runtime</p>
      <h1>Next Editor starter project is running.</h1>
      <p>
        This runtime is mounted separately from the existing single-file preview
        while the WebContainer integration is phased in.
      </p>
    </main>
  );
}`,
        },
      },
      "styles.css": {
        file: {
          contents: `:root {
  color: #e2e8f0;
  background: radial-gradient(circle at top, #1e293b, #020617 65%);
  font-family: "IBM Plex Sans", system-ui, sans-serif;
}

body {
  margin: 0;
  min-height: 100vh;
}

#root {
  min-height: 100vh;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  align-content: center;
  gap: 1rem;
  padding: 3rem;
}

.eyebrow {
  margin: 0;
  color: #38bdf8;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

h1,
p {
  margin: 0;
  max-width: 40rem;
}`,
        },
      },
    },
  },
};

function getRuntimeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown WebContainer runtime error";
}

export const WebContainerRuntimeProvider: React.FC<
  WebContainerRuntimeProviderProps
> = ({ children }) => {
  const instanceRef = useRef<WebContainer | null>(null);
  const devServerListenerCleanupRef = useRef<(() => void) | null>(null);
  const hasMountedStarterRef = useRef(false);
  const [status, setStatus] = useState<WebContainerRuntimeStatus>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);

  const isSupported = window.crossOriginIsolated;

  const appendOutput = useCallback((chunk: string) => {
    setLastOutput((current) => {
      const next = `${current ?? ""}${chunk}`;
      return next.slice(-2000);
    });
  }, []);

  const resetRuntime = useCallback(() => {
    devServerListenerCleanupRef.current?.();
    devServerListenerCleanupRef.current = null;
    instanceRef.current?.teardown();
    instanceRef.current = null;
    hasMountedStarterRef.current = false;
    setStatus("idle");
    setPreviewUrl(null);
    setErrorMessage(null);
    setLastOutput(null);
  }, []);

  const bootInstance = useCallback(async () => {
    if (instanceRef.current) {
      return instanceRef.current;
    }

    const { WebContainer } = await import("@webcontainer/api");
    const instance = await WebContainer.boot({
      coep: "require-corp",
      workdirName: "next-editor-runtime",
    });

    instanceRef.current = instance;

    return instance;
  }, []);

  const startRuntime = useCallback(async () => {
    if (!isSupported) {
      setStatus("error");
      setErrorMessage(
        "WebContainers require cross-origin isolation. Reload the app from the configured dev or deployed host.",
      );
      return;
    }

    if (
      status === "booting" ||
      status === "mounting" ||
      status === "installing" ||
      status === "starting"
    ) {
      return;
    }

    try {
      setErrorMessage(null);
      setLastOutput(null);
      setPreviewUrl(null);
      setStatus("booting");

      const instance = await bootInstance();

      if (!hasMountedStarterRef.current) {
        setStatus("mounting");
        await instance.mount(starterProjectFiles);
        hasMountedStarterRef.current = true;
      }

      setStatus("installing");
      const installProcess = await instance.spawn("npm", ["install"]);
      installProcess.output.pipeTo(
        new WritableStream({
          write(chunk) {
            appendOutput(chunk);
          },
        }),
      );

      const installExitCode = await installProcess.exit;
      if (installExitCode !== 0) {
        throw new Error("npm install failed inside the WebContainer runtime");
      }

      devServerListenerCleanupRef.current?.();
      devServerListenerCleanupRef.current = instance.on(
        "server-ready",
        (_port, url) => {
          setPreviewUrl(url);
          setStatus("ready");
        },
      );

      setStatus("starting");
      const devProcess = await instance.spawn("npm", ["run", "dev"]);
      devProcess.output.pipeTo(
        new WritableStream({
          write(chunk) {
            appendOutput(chunk);
          },
        }),
      );
    } catch (error) {
      setStatus("error");
      setErrorMessage(getRuntimeErrorMessage(error));
    }
  }, [appendOutput, bootInstance, isSupported, status]);

  useEffect(() => {
    return () => {
      resetRuntime();
    };
  }, [resetRuntime]);

  const actionsValue = useMemo<WebContainerRuntimeActions>(
    () => ({
      startRuntime,
      resetRuntime,
    }),
    [resetRuntime, startRuntime],
  );

  const metadataValue = useMemo<WebContainerRuntimeMetadata>(
    () => ({
      status,
      previewUrl,
      isSupported,
      errorMessage,
      lastOutput,
    }),
    [errorMessage, isSupported, lastOutput, previewUrl, status],
  );

  return (
    <WebContainerRuntimeActionsContext value={actionsValue}>
      <WebContainerRuntimeMetadataContext value={metadataValue}>
        {children}
      </WebContainerRuntimeMetadataContext>
    </WebContainerRuntimeActionsContext>
  );
};
