import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteContainer } from "../src/remote/RemoteContainer";

const agentUrl = process.env.REMOTE_RUNTIME_AGENT_WS;
const endpoint = process.env.REMOTE_RUNTIME_ENDPOINT;
if (process.env.CI && !agentUrl && !endpoint) {
  throw new Error("REMOTE_RUNTIME_AGENT_WS or REMOTE_RUNTIME_ENDPOINT is required for conformance in CI");
}
if (endpoint && !process.env.REMOTE_RUNTIME_AUTH_TOKEN) throw new Error("REMOTE_RUNTIME_AUTH_TOKEN is required in boot mode");

async function collect(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let output = "";
  while (true) { const { done, value } = await reader.read(); if (done) return output; output += value; }
}

describe.skipIf(!agentUrl && !endpoint)("RemoteContainer conformance", () => {
  let container: RemoteContainer;

  beforeAll(async () => {
    container = endpoint
      ? await RemoteContainer.boot({ endpoint, runtime: "go1.26.5", authorizationToken: process.env.REMOTE_RUNTIME_AUTH_TOKEN })
      : await RemoteContainer.attach({
          wsUrl: agentUrl!,
          previewUrlTemplate: "http://127.0.0.1:8600/proxy/{{port}}",
        });
  });

  afterAll(() => container?.teardown());

  it("mounts and exercises the Tier-1 filesystem matrix", async () => {
    await container.mount({
      "hello.txt": { file: { contents: "hello" } },
      empty: { directory: {} },
      link: { file: { symlink: "hello.txt" } },
    });
    expect(await container.fs.readFile("hello.txt", "utf-8")).toBe("hello");
    await container.fs.writeFile("binary", new Uint8Array([0, 255, 1]));
    expect(await container.fs.readFile("binary")).toEqual(new Uint8Array([0, 255, 1]));
    await container.fs.mkdir("created");
    await expect(container.fs.mkdir("created")).rejects.toThrow(/^EEXIST:/);
    const entries = await container.fs.readdir(".", { withFileTypes: true });
    expect(entries.find(({ name }) => name === "created")?.isDirectory()).toBe(true);
    await container.fs.rename("hello.txt", "renamed.txt");
    await expect(container.fs.readFile("hello.txt")).rejects.toThrow(/^ENOENT:/);
    await container.fs.rm("created");
  });

  it("spawns pipe and PTY processes with exit, resize, and kill semantics", async () => {
    const piped = await container.spawn("sh", ["-c", "printf stdout; printf stderr >&2; exit 7"]);
    expect(await collect(piped.output)).toContain("stdoutstderr");
    expect(await piped.exit).toBe(7);

    const terminal = await container.spawn("sh", ["-c", "stty size"], { terminal: { cols: 93, rows: 41 } });
    expect(await collect(terminal.output)).toContain("41 93");
    expect(await terminal.exit).toBe(0);

    const long = await container.spawn("sh", ["-c", "sleep 100 & wait"]);
    long.kill();
    expect([137, 143]).toContain(await long.exit);
  });

  it("emits recursive watch events", async () => {
    const event = new Promise<{ type: string; filename: string }>((resolve) => {
      const watcher = container.fs.watch(".", { recursive: true }, (type, filename) => {
        if (String(filename).endsWith("watched.txt")) {
          watcher.close();
          resolve({ type, filename: String(filename) });
        }
      });
    });
    await container.fs.writeFile("watched.txt", "change");
    await expect(event).resolves.toMatchObject({ filename: "watched.txt" });
  });

  it("round-trips export snapshots", async () => {
    const exported = await container.export(".", { format: "zip" });
    expect(exported).toBeInstanceOf(Uint8Array);
    await container.mount(exported, { mountPoint: "restored" });
    expect(await container.fs.readFile("restored/renamed.txt", "utf-8")).toBe("hello");
  });

  it("translates listening ports into port and server-ready events", async () => {
    await container.fs.writeFile("server.go", `package main
import "net/http"
func main() { _ = http.ListenAndServe(":18080", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })) }
`);
    const ready = new Promise<string>((resolve) => {
      const off = container.on("server-ready", (port, url) => {
        if (port === 18080) { off(); resolve(url); }
      });
    });
    const server = await container.spawn("go", ["run", "server.go"]);
    await expect(ready).resolves.toContain("18080");
    server.kill();
    await server.exit;
  });
});
