// A TypeScript project: tsx runs it, esbuild (the wasm build pnpm installs
// here) transforms a file, tsc type-checks it. Every step throws when it does
// not hold.
import type { HarnessApi } from "../webnode-harness";
import { withoutControlSequences as strip } from "./text";

export default async function (api: HarnessApi) {
  await api.call("mount", {
    "package.json": {
      file: {
        contents: JSON.stringify({
          name: "typescript-lesson",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: { dev: "tsx main.ts" },
          devDependencies: { tsx: "^4.19.2", typescript: "^5.7.2" },
        }),
      },
    },
    "main.ts": {
      file: {
        contents: `import { describeSquares, greet } from "./helpers.js";\nconsole.log(greet("TypeScript"));\nfor (const line of describeSquares([1, 2, 3])) console.log(line);\nenum Color { Red, Green }\nconsole.log(Color.Green, Color[0]);\n`,
      },
    },
    "helpers.ts": {
      file: {
        contents: `export function greet(name: string): string { return \`Hello, \${name} lessons!\`; }\nexport function describeSquares(values: number[]): string[] { return values.map((value) => \`\${value} squared is \${value * value}\`); }\n`,
      },
    },
  });
  const step = async (
    label: string,
    line: string,
    timeoutMs: number,
    holds: (output: string) => boolean,
  ) => {
    const started = Date.now();
    const result = await api.sh(line, { timeoutMs });
    const output = strip(result.output);
    api.check(
      `${label} (${Date.now() - started} ms)`,
      result.code === 0 && holds(output),
      `exit ${result.code}${result.timedOut ? ", timed out" : ""}: ${JSON.stringify(output.slice(-1200))}`,
    );
  };
  await step("pnpm install exits 0", "pnpm install", 180000, (output) =>
    /\+ tsx 4\.\d+\.\d+\n\+ typescript 5\.\d+\.\d+\n/.test(output),
  );
  await step("tsx runs the program", "pnpm dev", 60000, (output) =>
    output.endsWith(
      "Hello, TypeScript lessons!\n1 squared is 1\n2 squared is 4\n3 squared is 9\n1 Red\n",
    ),
  );
  await step(
    "esbuild is installed as its wasm build",
    "cat node_modules/esbuild/package.json | head -3",
    20000,
    (output) => output.includes(`"name": "esbuild-wasm"`),
  );
  await step(
    "esbuild transforms TypeScript",
    "npx esbuild --version; echo 'let x: number = 1; console.log(x)' > a.ts; npx esbuild a.ts",
    120000,
    (output) => /^\d+\.\d+\.\d+\nlet x = 1;\nconsole\.log\(x\);\n$/.test(output),
  );
  await step(
    "tsc type-checks the program",
    "npx tsc --version && npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext main.ts; echo tsc-exit $?",
    120000,
    (output) => /^Version 5\.\d+\.\d+\ntsc-exit 0\n$/.test(output),
  );
}
