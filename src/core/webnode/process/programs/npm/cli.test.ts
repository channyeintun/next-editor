// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createPackageSpec, parseArgs, splitSpec } from "./cli";

const command = (...argv: string[]) => parseArgs(argv).command;

describe("parseArgs", () => {
  it("maps invoked names to tools", () => {
    expect(parseArgs(["/usr/bin/pnpm", "install"]).tool).toBe("pnpm");
    expect(parseArgs(["npx", "vite"])).toMatchObject({ tool: "npm", invokedAs: "npx" });
    expect(parseArgs(["pnpx", "vite"]).command).toMatchObject({ kind: "exec", mode: "dlx" });
    expect(parseArgs(["bunx", "vite"]).command).toMatchObject({ kind: "exec", mode: "auto" });
    expect(parseArgs(["npm-cli.js", "-v"]).tool).toBe("npm");
  });

  it("reads versions and help", () => {
    for (const argv of [
      ["npm", "-v"],
      ["pnpm", "--version"],
      ["yarn", "-v"],
      ["npx", "--version"],
      ["bun", "-v"],
    ]) {
      expect(command(...argv)).toEqual({ kind: "version" });
    }
    expect(command("pnpm", "--help")).toEqual({ kind: "help" });
    expect(command("npm")).toEqual({ kind: "help" });
  });

  it("parses install and its aliases", () => {
    for (const argv of [
      ["npm", "i"],
      ["npm", "ci"],
      ["npm", "install"],
      ["pnpm", "install", "--frozen-lockfile"],
      ["pnpm", "i"],
      ["yarn"],
      ["yarn", "install"],
      ["bun", "install"],
    ]) {
      expect(command(...argv)).toEqual({ kind: "install" });
    }
  });

  it("parses add with its save flags", () => {
    expect(command("pnpm", "add", "-D", "vite@5")).toEqual({
      kind: "add",
      specs: ["vite@5"],
      save: "dev",
      exact: false,
    });
    expect(command("npm", "install", "--save-dev", "-E", "a", "b")).toEqual({
      kind: "add",
      specs: ["a", "b"],
      save: "dev",
      exact: true,
    });
    expect(command("yarn", "add", "--peer", "react")).toMatchObject({ save: "peer" });
    expect(command("yarn", "add", "-P", "react")).toMatchObject({ save: "peer" });
    expect(command("npm", "i", "-P", "react")).toMatchObject({ save: "prod" });
    expect(command("pnpm", "add", "-O", "x")).toMatchObject({ save: "optional" });
    expect(command("npm", "i", "--save-peer", "x")).toMatchObject({ save: "peer" });
    expect(command("bun", "add", "-d", "x")).toMatchObject({ save: "dev" });
    expect(command("npm", "i", "--some-unknown-flag", "x")).toMatchObject({
      kind: "add",
      specs: ["x"],
    });
  });

  it("rejects global installs", () => {
    expect(command("npm", "i", "-g", "typescript")).toEqual({ kind: "global", name: "i" });
    expect(command("pnpm", "--global", "add", "x")).toMatchObject({ kind: "global" });
  });

  it("parses remove", () => {
    for (const name of ["remove", "rm", "uninstall", "un"]) {
      expect(command("pnpm", name, "a", "b")).toEqual({ kind: "remove", names: ["a", "b"] });
    }
  });

  it("passes script arguments the way each tool does", () => {
    expect(command("pnpm", "run", "dev", "--port", "3000")).toEqual({
      kind: "run",
      script: "dev",
      args: ["--port", "3000"],
      ifPresent: false,
    });
    expect(command("pnpm", "run", "dev", "--", "--port", "3000")).toMatchObject({
      args: ["--port", "3000"],
    });
    expect(command("npm", "run", "dev", "--silent", "x", "--", "--port", "3000")).toMatchObject({
      args: ["x", "--port", "3000"],
    });
    expect(command("npm", "run", "--if-present", "build")).toMatchObject({
      script: "build",
      ifPresent: true,
    });
    expect(command("npm", "run")).toEqual({
      kind: "run",
      script: null,
      args: [],
      ifPresent: false,
    });
    expect(command("yarn", "run", "test", "--watch")).toMatchObject({ args: ["--watch"] });
  });

  it("treats unknown commands as scripts for pnpm, yarn and bun, but not npm", () => {
    expect(command("pnpm", "dev", "--host")).toEqual({
      kind: "implicit",
      name: "dev",
      args: ["--host"],
    });
    expect(command("yarn", "vite")).toEqual({ kind: "implicit", name: "vite", args: [] });
    expect(command("bun", "dev")).toMatchObject({ kind: "implicit" });
    expect(command("npm", "dev")).toEqual({ kind: "unknown", name: "dev" });
    expect(command("npm", "test", "--", "--watch")).toMatchObject({
      kind: "run",
      script: "test",
      args: ["--watch"],
    });
    expect(command("npm", "start")).toMatchObject({ kind: "run", script: "start" });
    expect(command("npm", "t")).toMatchObject({ kind: "run", script: "test" });
  });

  it("parses exec, npx and dlx", () => {
    expect(command("npx", "-y", "cowsay@1.6.0", "hi")).toEqual({
      kind: "exec",
      mode: "auto",
      command: "cowsay@1.6.0",
      args: ["hi"],
      packages: [],
      shell: null,
    });
    expect(command("npx", "-p", "typescript", "--package=tsx", "tsc", "--init")).toMatchObject({
      packages: ["typescript", "tsx"],
      command: "tsc",
      args: ["--init"],
    });
    expect(command("npm", "exec", "--", "vite", "--port", "1")).toMatchObject({
      command: "vite",
      args: ["--port", "1"],
    });
    expect(command("pnpm", "exec", "tsc")).toMatchObject({ mode: "local", command: "tsc" });
    expect(command("pnpm", "dlx", "create-vite")).toMatchObject({
      mode: "dlx",
      command: "create-vite",
    });
    expect(command("yarn", "dlx", "x")).toMatchObject({ mode: "dlx" });
    expect(command("npx", "-c", "echo $PATH")).toMatchObject({
      shell: "echo $PATH",
      command: null,
    });
  });

  it("parses create and npm init <name>", () => {
    expect(command("npm", "create", "vite@latest", "my-app")).toEqual({
      kind: "create",
      name: "vite@latest",
      args: ["my-app"],
    });
    expect(command("npm", "init", "vite", "app")).toMatchObject({ kind: "create", name: "vite" });
    expect(command("npm", "init", "-y")).toEqual({ kind: "init", yes: true });
    expect(command("pnpm", "init")).toEqual({ kind: "init", yes: false });
  });

  it("accepts the maintenance commands", () => {
    for (const name of [
      "config",
      "cache",
      "store",
      "prune",
      "dedupe",
      "audit",
      "fund",
      "outdated",
    ]) {
      expect(command("pnpm", name, "anything")).toEqual({ kind: "noop", name });
    }
    expect(command("pnpm", "update")).toEqual({ kind: "update" });
    expect(command("npm", "ls")).toEqual({ kind: "ls" });
    expect(command("pnpm", "why", "react")).toEqual({ kind: "why", names: ["react"] });
  });

  it("reads -C, --prefix and --registry", () => {
    expect(parseArgs(["pnpm", "-C", "app", "install"])).toMatchObject({
      dir: "app",
      command: { kind: "install" },
    });
    expect(parseArgs(["npm", "install", "--prefix", "/x"])).toMatchObject({ dir: "/x" });
    expect(parseArgs(["npm", "install", "--registry=https://r.test"])).toMatchObject({
      registry: "https://r.test",
    });
  });
});

describe("spec helpers", () => {
  it("names create packages", () => {
    expect(createPackageSpec("vite@latest")).toBe("create-vite@latest");
    expect(createPackageSpec("@scope")).toBe("@scope/create");
    expect(createPackageSpec("@scope/app@1")).toBe("@scope/create-app@1");
  });

  it("splits name@range", () => {
    expect(splitSpec("@s/a@^1")).toEqual({ name: "@s/a", range: "^1" });
    expect(splitSpec("a")).toEqual({ name: "a", range: null });
  });
});
