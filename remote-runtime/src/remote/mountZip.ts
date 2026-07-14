import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { RcpError } from "../rcp/errors";
import { RCP_LIMITS } from "../rcp/types";
import type { FileSystemTree } from "./types";

const UNIX = 3;
const MODE_FILE = 0o100644;
const MODE_DIR = 0o40755;
const MODE_SYMLINK = 0o120777;

function safePart(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new RcpError("EPROTO", `unsafe tree entry: ${JSON.stringify(name)}`);
  }
}

export function treeToZip(tree: FileSystemTree): Uint8Array {
  const files: Zippable = {};
  const walk = (current: FileSystemTree, prefix: string): void => {
    for (const [name, node] of Object.entries(current)) {
      safePart(name);
      const path = `${prefix}${name}`;
      if ("directory" in node) {
        files[`${path}/`] = [new Uint8Array(), { os: UNIX, attrs: MODE_DIR << 16 }];
        walk(node.directory, `${path}/`);
      } else if ("symlink" in node.file) {
        files[path] = [strToU8(node.file.symlink), { os: UNIX, attrs: MODE_SYMLINK << 16 }];
      } else {
        const contents = typeof node.file.contents === "string"
          ? strToU8(node.file.contents)
          : node.file.contents;
        files[path] = [contents, { os: UNIX, attrs: MODE_FILE << 16 }];
      }
    }
  };
  walk(tree, "");
  const archive = zipSync(files, { level: 6 });
  if (archive.byteLength > RCP_LIMITS.maxMountBytes) {
    throw new RcpError("ELIMIT", "mount archive exceeds 256 MiB");
  }
  return archive;
}

function readUnixModes(zip: Uint8Array): Map<string, number> {
  const modes = new Map<string, number>();
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let offset = 0; offset + 46 <= zip.byteLength;) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const madeBy = view.getUint16(offset + 4, true) >>> 8;
    const externalAttrs = view.getUint32(offset + 38, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > zip.byteLength) throw new RcpError("EPROTO", "truncated zip directory");
    if (madeBy === UNIX) modes.set(strFromU8(zip.subarray(nameStart, nameEnd)), externalAttrs >>> 16);
    offset = nameEnd + extraLength + commentLength;
  }
  return modes;
}

function ensureDirectory(root: FileSystemTree, parts: string[]): FileSystemTree {
  let tree = root;
  for (const part of parts) {
    safePart(part);
    const existing = tree[part];
    if (!existing) tree[part] = { directory: {} };
    else if (!("directory" in existing)) throw new RcpError("EPROTO", `zip path collision at ${part}`);
    tree = (tree[part] as { directory: FileSystemTree }).directory;
  }
  return tree;
}

export function zipToTree(zip: Uint8Array): FileSystemTree {
  if (zip.byteLength > RCP_LIMITS.maxMountBytes) {
    throw new RcpError("ELIMIT", "mount archive exceeds 256 MiB");
  }
  const modes = readUnixModes(zip);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw new RcpError("EPROTO", "invalid zip archive");
  }
  const tree: FileSystemTree = {};
  for (const [rawPath, contents] of Object.entries(entries)) {
    if (rawPath.startsWith("/") || rawPath.includes("\\")) {
      throw new RcpError("EPROTO", `unsafe zip path: ${rawPath}`);
    }
    const directory = rawPath.endsWith("/");
    const parts = rawPath.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) {
      throw new RcpError("EPROTO", `unsafe zip path: ${rawPath}`);
    }
    if (parts.length === 0) continue;
    const name = parts.pop()!;
    const parent = ensureDirectory(tree, parts);
    if (directory) {
      ensureDirectory(parent, [name]);
      continue;
    }
    if (parent[name]) throw new RcpError("EPROTO", `duplicate zip entry: ${rawPath}`);
    const mode = modes.get(rawPath) ?? MODE_FILE;
    parent[name] = (mode & 0o170000) === 0o120000
      ? { file: { symlink: strFromU8(contents) } }
      : { file: { contents } };
  }
  return tree;
}
