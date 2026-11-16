// @vitest-environment node
// Differential tests: the legacy and WHATWG `url` helpers against Node's own `url`.
import nodeUrlModule from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setRuntime, type ProcessRuntime } from "../runtime";
import url, {
  domainToASCII,
  domainToUnicode,
  fileURLToPath,
  pathToFileURL,
  urlToHttpOptions,
} from "./url";

/** Node's url with the legacy `resolveObject` and `Url`, which @types/node omits. */
const nodeUrl = nodeUrlModule as typeof nodeUrlModule & {
  resolveObject(from: string, to: string): unknown;
  Url: new () => object;
};

/** Own enumerable fields, with a parsed query flattened the same way. */
function fields(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as object)) {
    out[key] = field !== null && typeof field === "object" ? { ...field } : field;
  }
  return out;
}

/** The thrown error's comparable parts, or the value returned. */
function outcome(run: () => unknown): unknown {
  try {
    const value = run();
    return { value: typeof value === "object" && value !== null ? fields(value) : value };
  } catch (error) {
    const e = error as { code?: string; name?: string; message?: string };
    return { error: { code: e.code, name: e.name, message: e.message } };
  }
}

const parseInputs = [
  "",
  "   ",
  "http://www.example.com",
  "http://www.example.com/",
  "HTTP://WWW.EXAMPLE.COM/PATH",
  "http://user:pass@host.com:8080/p/a/t/h?query=string#hash",
  "https://user@host.com/",
  "http://a@b@c/",
  "http://a@b?@c",
  "http://a.com:/x",
  "http://x.com/path?that's#all, folks",
  "http://x:1/' <>\"`/{}|\\^'",
  "http://ex.com/foo\\bar",
  "http:\\\\evil-phisher\\foo.html",
  "HtTp://x.y.cOm*a/b/c?d=e#f gh",
  "http://x.y.com+a/b/c",
  "http://[::1]:8000/a",
  "http://[fe80::1%25eth0]/",
  "http://192.168.0.1:8080/x",
  "http://0x7f.1/",
  "http://例子.测试/",
  "http://www.ÄFFCHEN.de",
  "http://xn--n3h.net/",
  "http://www.example.com/a/b/../c/./d.html",
  "  http://www.example.com/trim  ",
  "http://ex.com/\ttab\nnewline\rcr",
  "javascript:alert(1)",
  "javascript:alert('hi');;alert(\"there\")",
  "mailto:local@domain.com",
  "mailto:foo@bar.com?subject=hi",
  "xmpp:isaacschlueter@jabber.org",
  "file:///etc/passwd",
  "file://localhost/etc/passwd",
  "file:/etc/passwd",
  "file://foo/etc/node/",
  "file:///C:/foo",
  "/foo/bar?baz=quux#frag",
  "/foo/bar?baz=quux",
  "//some_path",
  "//user@host/path",
  "?query=string",
  "#hash",
  "foo.html",
  "a/b/c",
  "../a",
  "git+ssh://git@github.com:npm/cli.git",
  "git+https://github.com/npm/cli.git#v1.0.0",
  "svn+ssh://foo/bar",
  "dash-test://foo/bar",
  "dot.test://foo/bar",
  "coap://[FEDC:BA98:7654:3210:FEDC:BA98:7654:3210]",
  "s3://bucket/key",
  "ws://localhost:3000/socket",
  "http://-lovemonsterz.tumblr.com/rss",
  "http://atpass:foo%40bar@127.0.0.1:8080/path?search=foo#bar",
  "http://user%3Aname:pass@host",
  "http://host/?a=1&a=2&b=%20c",
  "http://host/?a=b#c?d=e",
  "http://host/p#h#h2",
  "http://x.com/a?b=c?d",
  "http://ex.com/%E2%82%AC",
  "http://ex.com/€",
  "http://a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q.r.s.t.u.v.w.x.y.z.com/",
  "http://bucket_name.s3.amazonaws.com/image.jpg",
  "http://www.narwhaljs.org/blog/categories?id=news",
  "http://mt0.google.com/vt/lyrs=m@114&hl=en&src=api&x=2&y=2&z=3&s=",
  "http://mt0.google.com/vt/lyrs=m@114???&hl=en&src=api&x=2&y=2&z=3&s=",
  "http://user:pass@mt0.google.com/vt/lyrs=m@114???&hl=en&src=api&x=2&y=2&z=3&s=",
  "http://_jabber._tcp.google.com:80/test",
  "http://x:y@_jabber._tcp.google.com:80/test",
  "http://a\r\" \t\n<'b:b@c\r\nd/e?f",
  "http://user:@host",
  "http://:pass@host",
  "http://@host",
  "http://host:65536/",
  "http://host:abc/",
  "http://a:b:c/",
  "http://host.com:8080:9090/",
  "http://[::1]x/",
  "http://a%20b/",
];

const resolvePairs = [
  ["/one/two/three", "four"],
  ["http://example.com/", "/one"],
  ["http://example.com/one", "/two"],
  ["http://example.com/one/", "two"],
  ["http://example.com/a/b/c", "../../d"],
  ["http://example.com/a/b/c", "../../../../d"],
  ["http://example.com/a/b/c", "./"],
  ["http://example.com/a/b/c", "."],
  ["http://example.com/a/b/c", ".."],
  ["http://example.com/a/b/c", "?q=1"],
  ["http://example.com/a/b/c?x=1", ""],
  ["http://example.com/a/b/c#h", "#k"],
  ["http://example.com/a", "//other.com/b"],
  ["http://example.com/a", "https://other.com/b"],
  ["http://example.com/a", "mailto:a@b.c"],
  ["http://example.com/a", "file:///etc/x"],
  ["http://example.com/a", "https:/b/c"],
  ["http://example.com/a", "https:b"],
  ["mailto:local1@domain1", "local2@domain2"],
  ["mailto:local1@domain1", "?subject=x"],
  ["mailto:a@b", "../c"],
  ["http://user:pass@example.com/a", "/b"],
  ["http://user:pass@example.com/a", "//other/b"],
  ["foo/bar", "../baz"],
  ["foo", "../.."],
  ["/foo/bar/baz", "../../../../../../a"],
  ["http://a/b/c/d;p?q", "g:h"],
  ["http://a/b/c/d;p?q", "g"],
  ["http://a/b/c/d;p?q", "./g"],
  ["http://a/b/c/d;p?q", "g/"],
  ["http://a/b/c/d;p?q", "/g"],
  ["http://a/b/c/d;p?q", "//g"],
  ["http://a/b/c/d;p?q", "?y"],
  ["http://a/b/c/d;p?q", "g?y"],
  ["http://a/b/c/d;p?q", "#s"],
  ["http://a/b/c/d;p?q", "g#s"],
  ["http://a/b/c/d;p?q", ";x"],
  ["http://a/b/c/d;p?q", "g;x"],
  ["http://a/b/c/d;p?q", ""],
  ["http://a/b/c/d;p?q", "../g"],
  ["http://a/b/c/d;p?q", "../.."],
  ["http://a/b/c/d;p?q", "../../g"],
  ["http://a/b/c/d;p?q", "/./g"],
  ["http://a/b/c/d;p?q", "g."],
  ["http://a/b/c/d;p?q", "g.."],
  ["http://a/b/c/d;p?q", "./../g"],
  ["http://a/b/c/d;p?q", "g/../h"],
  ["http://a/b/c/d;p?q", "http:g"],
  ["http://example.com", "b"],
  ["file:///a/b", "../c"],
  ["", "http://x.com/"],
  ["http://x.com/", ""],
  ["http://localhost", "file:///Users/foo"],
  ["http://localhost", "file://foo/Users"],
  ["https://example.com", "http://x.com"],
  ["http://example.com/x", "javascript:void(0)"],
];

describe("url legacy API matches Node", () => {
  beforeAll(() => {
    process.noDeprecation = true;
  });
  afterAll(() => {
    process.noDeprecation = false;
  });

  it.each(parseInputs)("parse(%j)", (input) => {
    const ours: unknown[] = [];
    const theirs: unknown[] = [];
    const calls: [() => unknown, () => unknown][] = [
      [() => url.format(input), () => nodeUrl.format(input)],
    ];
    for (const [query, slashes] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]) {
      calls.push([
        () => url.parse(input, query, slashes),
        () => nodeUrl.parse(input, query, slashes),
      ]);
    }
    for (const [mine, node] of calls) {
      const expected = outcome(node);
      // Node 24+ throws on an invalid port; Node 22 (our target) is lenient,
      // checked separately below.
      if ((expected as { error?: { code?: string } }).error?.code !== "ERR_INVALID_ARG_VALUE") {
        ours.push(outcome(mine));
        theirs.push(expected);
      }
    }
    expect(ours).toEqual(theirs);
  });

  it("moves an invalid port into the path with a DEP0170 warning, as Node 22", () => {
    const warnings: unknown[][] = [];
    const original = process.emitWarning;
    process.emitWarning = ((...args: unknown[]) => {
      warnings.push(args);
    }) as typeof process.emitWarning;
    try {
      expect(url.parse("git+ssh://git@github.com:npm/cli.git").href).toBe(
        "git+ssh://git@github.com/:npm/cli.git",
      );
      const odd = url.parse("http://a:b:c/");
      expect(odd.hostname).toBe("a");
      expect(odd.pathname).toBe("/:b:c/");
      expect(url.parse("http://host:abc/").href).toBe("http://host/:abc/");
      expect(url.parse("http://host.com:8080:9090/").host).toBe("host.com:9090");
      expect(() => url.parse("http://[::1]x/")).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_URL" }),
      );
    } finally {
      process.emitWarning = original;
    }
    expect(warnings).toEqual([
      [
        "The URL git+ssh://git@github.com:npm/cli.git is invalid. Future versions of Node.js will throw an error.",
        "DeprecationWarning",
        "DEP0170",
      ],
    ]);
  });

  it.each(resolvePairs)("resolve(%j, %j)", (from, to) => {
    expect(outcome(() => url.resolve(from, to))).toEqual(outcome(() => nodeUrl.resolve(from, to)));
    expect(outcome(() => url.resolveObject(from, to))).toEqual(
      outcome(() => nodeUrl.resolveObject(from, to)),
    );
  });

  it("formats legacy objects as Node does", () => {
    const objects: Record<string, unknown>[] = [
      {},
      { protocol: "http", host: "a.com", pathname: "/x" },
      { protocol: "http:", hostname: "a.com", port: 8080, pathname: "x" },
      { protocol: "https", hostname: "::1", port: "443", pathname: "/" },
      { protocol: "http", hostname: "[::1]", pathname: "/" },
      { protocol: "mailto", auth: "user", hostname: "host" },
      { protocol: "file", pathname: "/etc/passwd" },
      { protocol: "file:", pathname: "etc/passwd" },
      { protocol: "xmpp", host: "jabber.org", slashes: true },
      { protocol: "http", host: "a.com", query: { a: "1", b: ["2", "3"] } },
      { protocol: "http", host: "a.com", search: "x=1", query: { a: "1" } },
      { protocol: "http", host: "a.com", search: "?a#b", hash: "c" },
      { protocol: "http", host: "a.com", pathname: "/a?b#c" },
      { protocol: "http", auth: "us er:p@ss", host: "a.com" },
      { protocol: "http", host: "a.com", hash: "#x" },
      { pathname: "/only/path", search: "?q" },
      { host: "a.com", pathname: "rel" },
    ];
    for (const object of objects) {
      expect(url.format(object)).toBe(nodeUrl.format(object));
    }
  });

  it("rejects bad urlObject and url arguments with Node's errors", () => {
    for (const bad of [undefined, null, 1, true]) {
      expect(outcome(() => url.format(bad as never))).toEqual(
        outcome(() => nodeUrl.format(bad as never)),
      );
      expect(outcome(() => url.parse(bad as never))).toEqual(
        outcome(() => nodeUrl.parse(bad as never)),
      );
    }
  });

  it("returns a Url instance unchanged and constructs without new", () => {
    const parsed = url.parse("http://a.com/");
    expect(url.parse(parsed as never)).toBe(parsed);
    expect(parsed).toBeInstanceOf(url.Url);
    expect(fields(new url.Url())).toEqual(fields(new nodeUrl.Url()));
  });
});

describe("url WHATWG helpers match Node", () => {
  beforeAll(() => {
    setRuntime({ cwd: process.cwd(), env: {} } as unknown as ProcessRuntime);
  });
  afterAll(() => {
    setRuntime(null);
  });

  it("exports the platform URL classes", () => {
    expect(url.URL).toBe(globalThis.URL);
    expect(url.URLSearchParams).toBe(globalThis.URLSearchParams);
  });

  it("formats a WHATWG URL with each option", () => {
    const hrefs = [
      "http://user:pass@xn--6qqa088eba.com:8080/p/a?q=1#frag",
      "https://例子.测试/path?x#y",
      "http://a.com/",
      "http://a.com/?#",
      "http://:pass@a.com/",
      "file:///etc/passwd",
      "mailto:x@y.com",
      "http://[::1]:3000/",
    ];
    const options = [
      undefined,
      {},
      { auth: false },
      { fragment: false },
      { search: false },
      { unicode: true },
      { auth: false, fragment: false, search: false, unicode: true },
      { unicode: 1, auth: 0 },
    ];
    for (const href of hrefs) {
      for (const option of options) {
        expect(url.format(new URL(href), option as never)).toBe(
          nodeUrl.format(new URL(href), option as never),
        );
      }
    }
    expect(outcome(() => url.format(new URL("http://a/"), "x" as never))).toEqual(
      outcome(() => nodeUrl.format(new URL("http://a/"), "x" as never)),
    );
  });

  it("converts domains as Node does", () => {
    const domains = [
      "",
      "example.com",
      "EXAMPLE.com",
      "español.com",
      "中文.com",
      "xn--iñvalid.com",
      "xn--espaol-zwa.com",
      "xn--fiqs8s.xn--fiqz9s",
      "a b",
      "a/b",
      "a:80",
      "1.2.3.4",
      "0x7f.1",
      "[::1]",
      "ex%41mple.com",
      "ﬀ.com",
      "a..b",
      "-a.com",
    ];
    for (const domain of domains) {
      expect(domainToASCII(domain)).toBe(nodeUrl.domainToASCII(domain));
      expect(domainToUnicode(domain)).toBe(nodeUrl.domainToUnicode(domain));
    }
    expect(outcome(() => (domainToASCII as () => string)())).toEqual(
      outcome(() => (nodeUrl.domainToASCII as () => string)()),
    );
  });

  it("converts file URLs to paths as Node does (posix)", () => {
    const inputs: (string | URL)[] = [
      "file:///etc/passwd",
      "file:///a%20b/c%25d",
      "file:///%E2%82%AC/x",
      "file://localhost/etc",
      "file:///a/b/",
      "file:///a%2fb",
      "file:///a%2Fb",
      "file:///a%5cb",
      "file://host/etc",
      "http://x.com/a",
      new URL("file:///tmp/x?y#z"),
      "not a url",
    ];
    // Node names its own platform in the host error; webnode reports linux.
    const linuxHostError = {
      error: {
        code: "ERR_INVALID_FILE_URL_HOST",
        name: "TypeError",
        message: 'File URL host must be "localhost" or empty on linux',
      },
    };
    for (const input of inputs) {
      const theirs = outcome(() => nodeUrl.fileURLToPath(input));
      const hostError =
        (theirs as { error?: { code?: string } }).error?.code === "ERR_INVALID_FILE_URL_HOST";
      expect(outcome(() => fileURLToPath(input))).toEqual(hostError ? linuxHostError : theirs);
    }
    for (const bad of [undefined, null, 1, {}, { href: "x", protocol: "file:", path: "/" }]) {
      expect(outcome(() => fileURLToPath(bad as never))).toEqual(
        outcome(() => nodeUrl.fileURLToPath(bad as never)),
      );
    }
  });

  it("converts file URLs to paths as Node does (windows)", () => {
    const inputs = [
      "file:///C:/foo/bar",
      "file:///c:/a%20b",
      "file://server/share/x",
      "file://xn--fiqs8s/share",
      "file:///foo",
      "file:///C:/a%5Cb",
      "file:///C:/a%2fb",
    ];
    for (const input of inputs) {
      expect(outcome(() => fileURLToPath(input, { windows: true }))).toEqual(
        outcome(() => nodeUrl.fileURLToPath(input, { windows: true })),
      );
    }
  });

  it("converts paths to file URLs as Node does (posix)", () => {
    const paths = [
      "/",
      "/foo",
      "/foo/",
      "/foo bar",
      "/a%b",
      "/a\\b",
      "/a\nb",
      "/a\rb",
      "/a\tb",
      "/a?b",
      "/a#b",
      "/€",
      "/a/../b/./c",
      "relative/path",
      "relative/dir/",
      ".",
      "",
      "/a;b",
      "/a^b",
      "/a`b",
      "/a{b}",
      '/a"b',
      "/a<b>",
    ];
    for (const input of paths) {
      expect(pathToFileURL(input).href).toBe(nodeUrl.pathToFileURL(input).href);
      expect(pathToFileURL(input)).toBeInstanceOf(URL);
    }
    // Node 22 leaves "|" as the URL parser does (Node 24+ encodes it).
    expect(pathToFileURL("/a|b").href).toBe("file:///a|b");
    expect(pathToFileURL("/a[b]").href).toBe("file:///a[b]");
    for (const bad of [undefined, null, 1, {}]) {
      expect(outcome(() => pathToFileURL(bad as never))).toEqual(
        outcome(() => nodeUrl.pathToFileURL(bad as never)),
      );
    }
  });

  it("converts paths to file URLs as Node does (windows)", () => {
    const paths = [
      "C:\\foo\\bar",
      "C:\\foo\\",
      "c:/a b/c",
      "\\\\server\\share\\file",
      "\\\\server\\share\\a b",
      "\\\\server",
      "\\\\\\share",
      "C:\\a%b",
      "C:\\a#b?c",
    ];
    for (const input of paths) {
      expect(outcome(() => pathToFileURL(input, { windows: true }).href)).toEqual(
        outcome(() => nodeUrl.pathToFileURL(input, { windows: true }).href),
      );
    }
  });

  it("builds http options as Node does", () => {
    const hrefs = [
      "http://a.com/",
      "https://user:p%40ss@a.com:8443/p/a?q=1#h",
      "http://[::1]:3000/x",
      "http://user@a.com/",
      "http://:pw@a.com/",
    ];
    for (const href of hrefs) {
      expect(fields(urlToHttpOptions(new URL(href)))).toEqual(
        fields(nodeUrl.urlToHttpOptions(new URL(href))),
      );
    }
    for (const bad of [null, 1, "x"]) {
      expect(outcome(() => urlToHttpOptions(bad as never))).toEqual(
        outcome(() => nodeUrl.urlToHttpOptions(bad as never)),
      );
    }
  });

  it("has Node 22's exports", () => {
    expect(Object.keys(url).sort()).toEqual([
      "URL",
      "URLSearchParams",
      "Url",
      "domainToASCII",
      "domainToUnicode",
      "fileURLToPath",
      "format",
      "parse",
      "pathToFileURL",
      "resolve",
      "resolveObject",
      "urlToHttpOptions",
    ]);
  });
});
