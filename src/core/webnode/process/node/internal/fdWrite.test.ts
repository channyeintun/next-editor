// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { O_CREAT, O_RDWR, O_TRUNC } from "../../../kernel/vfs/types";
import { setRuntime } from "../../runtime";
import { createFakeRuntime } from "../../testing/fakeRuntime";
import { writeFd } from "./fdWrite";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

afterEach(() => {
  setRuntime(null);
});

function setup() {
  const rt = createFakeRuntime({ cwd: "/" });
  setRuntime(rt);
  return rt;
}

describe("writeFd", () => {
  it("writes a pipe through the stream write, blocking or with done", async () => {
    const rt = setup();
    const streamWrites = vi.spyOn(rt.fdStream, "write");
    writeFd(1, encoder.encode("one\n"));
    const done = await new Promise<Error | null>((resolve) => {
      writeFd(1, encoder.encode("two\n"), resolve);
    });
    expect(done).toBeNull();
    expect(streamWrites).toHaveBeenCalledTimes(2);
    expect(rt.stdout()).toBe("one\ntwo\n");
  });

  it("throws a blocking write's EPIPE, and hands one with done to done", async () => {
    const rt = setup();
    rt.closeReader(2);
    expect(() => writeFd(2, encoder.encode("lost\n"))).toThrow(
      expect.objectContaining({ code: "EPIPE" }),
    );
    const done = await new Promise<Error | null>((resolve) => {
      writeFd(2, encoder.encode("lost\n"), resolve);
    });
    expect(done).toEqual(expect.objectContaining({ code: "EPIPE" }));
  });

  it("writes a file at its own offset, past the stream write", () => {
    const rt = setup();
    const fd = rt.fs.open("/log", O_RDWR | O_CREAT | O_TRUNC, 0o644);
    const streamWrites = vi.spyOn(rt.fdStream, "write");
    writeFd(fd, encoder.encode("a\n"));
    let done: Error | null | undefined;
    writeFd(fd, encoder.encode("b\n"), (error) => {
      done = error;
    });
    // Complete when the call returns.
    expect(done).toBeNull();
    expect(streamWrites).not.toHaveBeenCalled();
    expect(decoder.decode(rt.fs.readFile("/log"))).toBe("a\nb\n");
  });

  it("writes nothing to /dev/null", () => {
    const rt = setup();
    vi.spyOn(rt.fdStream, "kind").mockReturnValue("null");
    const streamWrites = vi.spyOn(rt.fdStream, "write");
    const fileWrites = vi.spyOn(rt.fs, "write");
    let done: Error | null | undefined;
    writeFd(1, encoder.encode("gone\n"), (error) => {
      done = error;
    });
    expect(done).toBeNull();
    expect(streamWrites).not.toHaveBeenCalled();
    expect(fileWrites).not.toHaveBeenCalled();
    expect(rt.stdout()).toBe("");
  });

  it("fails as a closed fd's write fails", () => {
    setup();
    expect(() => writeFd(9, encoder.encode("x"))).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => writeFd(9, encoder.encode("x"), () => {})).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
  });
});
