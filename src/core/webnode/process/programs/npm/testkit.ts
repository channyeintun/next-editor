// Test helpers for the package manager (imported only by its tests): a small
// tar writer (ustar, pax and GNU long names), gzip through fflate, and an
// in-memory npm registry that serves abbreviated packuments and tarballs.
import { gzipSync } from "fflate";
import { integrityOf } from "./integrity";
import type { FetchLike, PackageVersion, Packument } from "./registry";

/** One entry to write into a test tarball. */
export interface TarInput {
  path: string;
  data?: Uint8Array | string;
  mode?: number;
  /** "0" file (default), "5" directory, "2" symlink. */
  type?: "0" | "5" | "2";
  /** How to store a long path: pax `x` header (default), GNU `L`, or the ustar prefix field. */
  longName?: "pax" | "gnu" | "prefix";
  /** Raw pax records written in an `x` header before the entry. */
  pax?: Record<string, string>;
}

const encoder = new TextEncoder();

function writeString(block: Uint8Array, offset: number, length: number, text: string): void {
  block.set(encoder.encode(text).subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function header(name: string, size: number, mode: number, type: string, prefix = ""): Uint8Array {
  const block = new Uint8Array(512);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  writeString(block, 257, 6, "ustar\0");
  writeString(block, 263, 2, "00");
  writeString(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function padded(data: Uint8Array): Uint8Array[] {
  const rest = data.length % 512;
  return rest === 0 ? [data] : [data, new Uint8Array(512 - rest)];
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) {
    length = `${length}${body}`.length;
  }
  return `${length}${body}`;
}

/** Writes an uncompressed tar archive. */
export function writeTar(entries: TarInput[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const data =
      typeof entry.data === "string"
        ? encoder.encode(entry.data)
        : (entry.data ?? new Uint8Array(0));
    const type = entry.type ?? "0";
    const mode = entry.mode ?? (type === "5" ? 0o755 : 0o644);
    let name = entry.path;
    let prefix = "";
    if (entry.pax) {
      const records = Object.entries(entry.pax)
        .map(([key, value]) => paxRecord(key, value))
        .join("");
      const pax = encoder.encode(records);
      parts.push(header("PaxHeader", pax.length, 0o644, "x"), ...padded(pax));
    }
    if (encoder.encode(name).length > 100) {
      const style = entry.longName ?? "pax";
      if (style === "pax") {
        const pax = encoder.encode(paxRecord("path", name));
        parts.push(header("PaxHeader", pax.length, 0o644, "x"), ...padded(pax));
        name = name.slice(0, 100);
      } else if (style === "gnu") {
        const long = encoder.encode(`${name}\0`);
        parts.push(header("././@LongLink", long.length, 0o644, "L"), ...padded(long));
        name = name.slice(0, 100);
      } else {
        const split = name.lastIndexOf("/", 155);
        prefix = name.slice(0, split);
        name = name.slice(split + 1);
      }
    }
    parts.push(header(name, type === "0" ? data.length : 0, mode, type, prefix));
    if (type === "0" && data.length > 0) {
      parts.push(...padded(data));
    }
  }
  parts.push(new Uint8Array(1024));
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Gzips bytes. */
export function gzip(data: Uint8Array): Uint8Array {
  return gzipSync(data);
}

/** A package version served by the fake registry. */
export interface FakePackage {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: string | Record<string, string>;
  os?: string[];
  cpu?: string[];
  scripts?: Record<string, string>;
  /** Extra files (path → contents); package.json is generated. */
  files?: Record<string, string | { data: string; mode: number }>;
  /** Serve a tarball whose bytes do not match the recorded integrity. */
  corrupt?: boolean;
}

export interface FakeRegistry {
  url: string;
  fetch: FetchLike;
  /** Every URL fetched, in order. */
  requests: string[];
  /** Adds or replaces a version after creation. */
  add(pkg: FakePackage, tags?: Record<string, string>): Promise<void>;
}

/** Builds the tarball for a fake package. */
export function packTarball(pkg: FakePackage): Uint8Array {
  const manifest: Record<string, unknown> = { name: pkg.name, version: pkg.version };
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bin",
    "os",
    "cpu",
    "scripts",
  ] as const) {
    if (pkg[field] !== undefined) {
      manifest[field] = pkg[field];
    }
  }
  const entries: TarInput[] = [
    { path: "package/package.json", data: JSON.stringify(manifest, null, 2) },
  ];
  for (const [path, file] of Object.entries(pkg.files ?? {})) {
    entries.push(
      typeof file === "string"
        ? { path: `package/${path}`, data: file }
        : { path: `package/${path}`, data: file.data, mode: file.mode },
    );
  }
  return gzip(writeTar(entries));
}

/**
 * An in-memory registry at `https://registry.test`. Versions are grouped into
 * packuments; `latest` is the highest version added unless `tags` says otherwise.
 */
export async function createFakeRegistry(
  packages: FakePackage[],
  tags: Record<string, Record<string, string>> = {},
): Promise<FakeRegistry> {
  const url = "https://registry.test";
  const packuments = new Map<string, Packument>();
  const tarballs = new Map<string, Uint8Array>();
  const requests: string[] = [];

  const add = async (pkg: FakePackage, extraTags: Record<string, string> = {}) => {
    const bytes = packTarball(pkg);
    const tarball = `${url}/${pkg.name}/-/${pkg.name.replace(/^@[^/]+\//, "")}-${pkg.version}.tgz`;
    const integrity = await integrityOf(bytes);
    tarballs.set(
      tarball,
      pkg.corrupt ? gzip(writeTar([{ path: "package/x", data: "tampered" }])) : bytes,
    );
    const packument = packuments.get(pkg.name) ?? { name: pkg.name, "dist-tags": {}, versions: {} };
    const version: PackageVersion = {
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies,
      optionalDependencies: pkg.optionalDependencies,
      peerDependencies: pkg.peerDependencies,
      peerDependenciesMeta: pkg.peerDependenciesMeta,
      bin: pkg.bin,
      os: pkg.os,
      cpu: pkg.cpu,
      dist: { tarball, integrity },
    };
    packument.versions[pkg.version] = version;
    const latest = packument["dist-tags"].latest;
    if (!latest || compareVersions(pkg.version, latest) > 0) {
      if (!pkg.version.includes("-")) {
        packument["dist-tags"].latest = pkg.version;
      }
    }
    Object.assign(packument["dist-tags"], extraTags);
    packuments.set(pkg.name, packument);
  };

  for (const pkg of packages) {
    await add(pkg);
  }
  for (const [name, table] of Object.entries(tags)) {
    const packument = packuments.get(name);
    if (packument) {
      Object.assign(packument["dist-tags"], table);
    }
  }

  const fetch: FetchLike = async (requestUrl) => {
    requests.push(requestUrl);
    const tarball = tarballs.get(requestUrl);
    if (tarball) {
      return new Response(tarball.slice().buffer, { status: 200 });
    }
    const path = decodeURIComponent(requestUrl.slice(url.length + 1));
    const packument = packuments.get(path);
    if (packument) {
      return new Response(JSON.stringify(packument), { status: 200 });
    }
    // `/<name>/<version-or-tag>`: one version's document.
    const slash = path.lastIndexOf("/");
    const owner = slash > 0 ? packuments.get(path.slice(0, slash)) : undefined;
    const wanted = path.slice(slash + 1);
    const version = owner?.versions[owner["dist-tags"][wanted] ?? wanted];
    if (version) {
      return new Response(JSON.stringify({ ...version, readme: "x".repeat(100) }), { status: 200 });
    }
    return new Response("Not found", { status: 404, statusText: "Not Found" });
  };

  return { url, fetch, requests, add };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => Number(part));
  const pb = b.split(/[.-]/).map((part) => Number(part));
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) {
      return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
  }
  return 0;
}
