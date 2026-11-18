// @vitest-environment node
import { describe, expect, it } from "vitest";
import { deviceOf, walkDevicePath } from "./devicePaths";
import { Vfs } from "./vfs/vfs";

/** A tree laid out as the kernel lays out /dev: each device a link to itself. */
function tree(): Vfs {
  const vfs = new Vfs();
  const setup = vfs.privileged;
  setup.mkdir("/dev", false, 0o755);
  for (const name of ["fd", "null", "tty"]) {
    setup.symlink(`/dev/${name}`, `/dev/${name}`);
  }
  setup.mkdir("/home/a", true, 0o755);
  setup.symlink("/", "/home/a/root");
  setup.symlink("/dev", "/home/a/dev");
  setup.symlink("../a", "/home/a/up");
  setup.symlink("/dev/null", "/home/a/mine");
  setup.writeFile("/home/a/f", new Uint8Array(0), 0o101, 0o644);
  return vfs;
}

describe("deviceOf", () => {
  it("names a device by its spelling, and leaves what a `..` or a last `/` decides to the walk", () => {
    expect(deviceOf("//dev/./null")).toBe("/dev/null");
    expect(deviceOf("/dev/fd/3")).toBe("/dev/fd/3");
    expect(deviceOf("/dev/fd/")).toBe("/dev/fd");
    expect(deviceOf("/dev/null/")).toBeNull();
    expect(deviceOf("/dev/null/.")).toBeNull();
    expect(deviceOf("/dev/fd/0/..")).toBeNull();
    expect(deviceOf("/dev/../dev/null")).toBeNull();
    expect(deviceOf("/dev")).toBeNull();
  });
});

describe("walkDevicePath", () => {
  it("takes /dev/fd for a directory and every other device for none, following the tree's links", () => {
    const vfs = tree();
    const walk = (path: string, follow = true) => walkDevicePath(vfs, path, follow);
    expect(walk("/dev/fd/..")).toEqual({ tree: "/dev" });
    expect(walk("/dev/fd/./../")).toEqual({ tree: "/dev" });
    expect(walk("/home/a/dev/fd/..")).toEqual({ tree: "/dev" });
    expect(walk("/home/a/up/root/dev/fd/../..")).toEqual({ tree: "/" });
    expect(walk("/dev/fd/../fd/../null")).toEqual({ device: "/dev/null" });
    expect(walk("/home/a/root/dev/fd/7")).toEqual({ device: "/dev/fd/7" });
    expect(walk("/dev/fd/../../home/a/f")).toEqual({ tree: "/home/a/f" });
    // The last link is followed only when asked.
    expect(walk("/dev/fd/../../home/a/mine")).toEqual({ device: "/dev/null" });
    expect(walk("/dev/fd/../../home/a/mine", false)).toEqual({ tree: "/home/a/mine" });
    expect(walk("/dev/fd/0/..")).toEqual({ error: "ENOTDIR" });
    expect(walk("/home/a/dev/null/..")).toEqual({ error: "ENOTDIR" });
    expect(walk("/dev/null/")).toEqual({ error: "ENOTDIR" });
    expect(walk("/dev/fd/x")).toEqual({ error: "ENOENT" });
    // What the tree answers after a device is the tree's to say.
    expect(walk("/dev/fd/../nope/x")).toEqual({ tree: "/dev/nope/x" });
    expect(walk("/dev/fd/../../home/a/f/x")).toEqual({ tree: "/home/a/f/x" });
  });

  it("leaves a path that reaches no device, or a loop of the tree's own links, to the tree", () => {
    const vfs = tree();
    vfs.privileged.symlink("/home/a/l2", "/home/a/l1");
    vfs.privileged.symlink("/home/a/l1", "/home/a/l2");
    expect(walkDevicePath(vfs, "/home/a/l1", true)).toBeNull();
    expect(walkDevicePath(vfs, "/home/a/f", true)).toBeNull();
    expect(walkDevicePath(vfs, "/home/a/nope/../f", true)).toBeNull();
  });
});
