// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  companionOf,
  coveredBySubstitution,
  platformDecision,
  substituteFor,
  wasiFamilyMember,
} from "./substitutions";

describe("substituteFor", () => {
  it("maps each native package to its WebAssembly build", () => {
    expect(substituteFor("esbuild", "^0.21.3")?.source).toBe("esbuild-wasm");
    expect(substituteFor("rollup", "^4.20.0")?.source).toBe("@rollup/wasm-node");
    expect(substituteFor("lightningcss", "^1.0.0")?.source).toBe("lightningcss-wasm");
    expect(substituteFor("@swc/core", "^1.0.0")?.source).toBe("@swc/wasm");
    expect(substituteFor("@parcel/watcher", "^2.0.0")?.source).toBe("@parcel/watcher-wasm");
    expect(substituteFor("react", "^19.0.0")).toBeNull();
  });

  it("leaves rollup before 4 alone (it is plain JavaScript)", () => {
    expect(substituteFor("rollup", "^3.29.0")).toBeNull();
    expect(substituteFor("rollup", "latest")?.source).toBe("@rollup/wasm-node");
  });

  it("substitutes rollup for a wide range that can reach 4", () => {
    for (const range of ["*", ">=3", "^3 || ^4", ">=2.0.0"]) {
      expect(substituteFor("rollup", range)?.source).toBe("@rollup/wasm-node");
    }
    expect(substituteFor("rollup", "3.29.0")).toBeNull();
    expect(substituteFor("rollup", "<4")).toBeNull();
  });

  it("adds the oxide wasm build beside @tailwindcss/oxide", () => {
    expect(substituteFor("@tailwindcss/oxide", "4.0.0")).toBeNull();
    expect(companionOf("@tailwindcss/oxide")).toEqual({ name: "@tailwindcss/oxide-wasm32-wasi" });
  });

  it("swaps platform family members for their wasm32-wasi member", () => {
    expect(wasiFamilyMember("@rolldown/binding-linux-x64-gnu")).toBe(
      "@rolldown/binding-wasm32-wasi",
    );
    expect(wasiFamilyMember("@oxc-parser/binding-darwin-arm64")).toBe(
      "@oxc-parser/binding-wasm32-wasi",
    );
    expect(wasiFamilyMember("@rolldown/binding-wasm32-wasi")).toBeNull();
    expect(wasiFamilyMember("@rolldown/pluginutils")).toBeNull();
  });

  it("knows which install scripts the table covers", () => {
    expect(coveredBySubstitution("esbuild")).toBe(true);
    expect(coveredBySubstitution("@tailwindcss/oxide")).toBe(true);
    expect(coveredBySubstitution("sharp")).toBe(false);
  });
});

describe("platformDecision", () => {
  it("skips optional native binaries even for linux-x64", () => {
    expect(
      platformDecision({ name: "@esbuild/linux-x64", os: ["linux"], cpu: ["x64"] }, true),
    ).toBe("skip-native");
    expect(
      platformDecision({ name: "@esbuild/darwin-arm64", os: ["darwin"], cpu: ["arm64"] }, true),
    ).toBe("skip-platform");
  });

  it("installs wasm32 builds", () => {
    expect(platformDecision({ name: "@rolldown/binding-wasm32-wasi", cpu: ["wasm32"] }, true)).toBe(
      "install",
    );
    expect(platformDecision({ name: "@x/y-wasm32-wasi" }, true)).toBe("install");
  });

  it("skips fsevents and packages excluded by os, cpu or libc", () => {
    expect(platformDecision({ name: "fsevents", os: ["darwin"] }, true)).toBe("skip-platform");
    expect(platformDecision({ name: "a", os: ["!linux"] }, false)).toBe("skip-platform");
    expect(platformDecision({ name: "a", libc: ["musl"] }, false)).toBe("skip-platform");
    expect(platformDecision({ name: "a", os: ["linux", "darwin"] }, false)).toBe("install");
    expect(platformDecision({ name: "plain" }, true)).toBe("install");
  });
});
