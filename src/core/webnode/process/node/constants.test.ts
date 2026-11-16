// @vitest-environment node
import { describe, expect, it } from "vitest";
import constants, { fsConstants } from "./constants";

describe("constants", () => {
  it("merges os, fs and crypto constants into one frozen table", () => {
    expect(Object.isFrozen(constants)).toBe(true);
    expect(constants.ENOENT).toBe(2);
    expect(constants.SIGKILL).toBe(9);
    expect(constants.PRIORITY_LOW).toBe(19);
    expect(constants.RTLD_LAZY).toBe(1);
    expect(constants.O_CREAT).toBe(0o100);
    expect(constants.S_IFDIR).toBe(0o040000);
    expect(constants.S_IRWXU).toBe(0o700);
    expect(constants.COPYFILE_FICLONE).toBe(2);
    expect(constants.RSA_PKCS1_PADDING).toBe(1);
  });

  it("has Linux fs values", () => {
    expect(fsConstants.O_DIRECTORY).toBe(65536);
    expect(fsConstants.O_NOFOLLOW).toBe(131072);
    expect(fsConstants.O_APPEND).toBe(1024);
    expect(fsConstants.O_SYNC).toBe(1052672);
  });
});
