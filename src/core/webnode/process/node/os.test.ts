// @vitest-environment node
import nodeOs from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime } from "../testing/fakeRuntime";
import { Buffer } from "./buffer";
import os from "./os";

afterEach(() => {
  setRuntime(null);
});

describe("os", () => {
  it("reports the simulated Linux machine", () => {
    expect(os.platform()).toBe("linux");
    expect(os.arch()).toBe("x64");
    expect(os.type()).toBe("Linux");
    expect(os.machine()).toBe("x86_64");
    expect(os.endianness()).toBe("LE");
    expect(os.EOL).toBe("\n");
    expect(os.devNull).toBe("/dev/null");
    expect(typeof os.release()).toBe("string");
    expect(typeof os.version()).toBe("string");
    expect(os.hostname()).toBe("localhost");
    expect(os.loadavg()).toEqual([0, 0, 0]);
  });

  it("falls back to the platform paths without a runtime", () => {
    expect(os.homedir()).toBe("/home");
    expect(os.tmpdir()).toBe("/tmp");
  });

  it("reads HOME and TMPDIR from the environment", () => {
    setRuntime(createFakeRuntime({ env: { HOME: "/home/me", TMPDIR: "/var/tmp/" } }));
    expect(os.homedir()).toBe("/home/me");
    expect(os.tmpdir()).toBe("/var/tmp");
    expect(os.userInfo().homedir).toBe("/home/me");
  });

  it("describes CPUs, memory and uptime with numbers", () => {
    const cpus = os.cpus();
    expect(cpus.length).toBe(os.availableParallelism());
    expect(cpus[0]).toEqual({
      model: "webnode virtual CPU",
      speed: 0,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    });
    expect(os.totalmem()).toBeGreaterThan(0);
    expect(os.freemem()).toBeLessThanOrEqual(os.totalmem());
    expect(os.uptime()).toBeGreaterThanOrEqual(0);
  });

  it("has a loopback interface shaped like Node's", () => {
    const real = Object.values(nodeOs.networkInterfaces())
      .flat()
      .find((entry) => entry?.internal && entry.family === "IPv4");
    const ours = os.networkInterfaces().lo;
    expect(ours[0].address).toBe("127.0.0.1");
    expect(Object.keys(ours[0]).sort()).toEqual(Object.keys(real ?? {}).sort());
  });

  it("returns userInfo as strings or Buffers", () => {
    const info = os.userInfo();
    expect(Object.keys(info).sort()).toEqual(["gid", "homedir", "shell", "uid", "username"]);
    expect(info.username).toBe("user");
    const buffers = os.userInfo({ encoding: "buffer" });
    expect(Buffer.isBuffer(buffers.username)).toBe(true);
  });

  it("validates and remembers priorities", () => {
    expect(os.getPriority()).toBe(0);
    os.setPriority(5);
    expect(os.getPriority()).toBe(5);
    os.setPriority(0, 0);
    expect(() => os.setPriority(0, 20)).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
    expect(() => os.getPriority("x" as unknown as number)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("has Linux constants with signals frozen", () => {
    expect(os.constants.signals.SIGINT).toBe(2);
    expect(os.constants.signals.SIGTERM).toBe(15);
    expect(os.constants.signals.SIGCHLD).toBe(17);
    expect(Object.isFrozen(os.constants.signals)).toBe(true);
    expect(os.constants.errno.ENOENT).toBe(2);
    expect(os.constants.priority.PRIORITY_HIGHEST).toBe(-20);
    expect(os.constants.dlopen.RTLD_NOW).toBe(2);
    expect(os.constants.UV_UDP_REUSEADDR).toBe(4);
  });

  it("exports every member Node's os has", () => {
    expect(Object.keys(nodeOs).filter((key) => !(key in os))).toEqual([]);
  });
});
