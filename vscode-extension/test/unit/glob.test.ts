import { describe, expect, it } from "vitest";
import { globToRegExp } from "../../src/capture/glob";

describe("globToRegExp", () => {
  it("matches simple star patterns within one segment", () => {
    const re = globToRegExp("*.secret");
    expect(re.test("creds.secret")).toBe(true);
    expect(re.test("dir/creds.secret")).toBe(false);
    expect(re.test("creds.secrets")).toBe(false);
  });

  it("matches ** across directories, including zero directories", () => {
    const re = globToRegExp("**/*.env");
    expect(re.test("a/b/.env.local")).toBe(false);
    expect(re.test("a/b/prod.env")).toBe(true);
    expect(re.test("prod.env")).toBe(true);
  });

  it("matches ? as a single non-separator character", () => {
    const re = globToRegExp("file?.txt");
    expect(re.test("file1.txt")).toBe(true);
    expect(re.test("file12.txt")).toBe(false);
    expect(re.test("file/.txt")).toBe(false);
  });

  it("escapes regex metacharacters", () => {
    const re = globToRegExp("a+b(c).txt");
    expect(re.test("a+b(c).txt")).toBe(true);
    expect(re.test("aab(c).txt")).toBe(false);
  });

  it("supports directory prefix patterns", () => {
    const re = globToRegExp("secrets/**");
    expect(re.test("secrets/key.pem")).toBe(true);
    expect(re.test("secrets/nested/deep.txt")).toBe(true);
    expect(re.test("other/key.pem")).toBe(false);
  });
});
