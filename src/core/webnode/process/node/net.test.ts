// @vitest-environment node
// The `net` builtin on the fake runtime's loopback network.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import net, { BlockList, Socket, SocketAddress, type Server } from "./net";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

function once<T = unknown[]>(
  emitter: { once(event: string, fn: (...a: never[]) => void): unknown },
  event: string,
): Promise<T> {
  return new Promise((resolve) => {
    emitter.once(event, ((...args: unknown[]) => resolve(args as T)) as (...a: never[]) => void);
  });
}

function listen(server: Server, ...args: unknown[]): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(...args, () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function collect(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("net module surface", () => {
  it("has Node 22's exports", () => {
    expect(Object.keys(net).sort()).toEqual(
      [
        "_normalizeArgs",
        "BlockList",
        "SocketAddress",
        "connect",
        "createConnection",
        "createServer",
        "isIP",
        "isIPv4",
        "isIPv6",
        "Server",
        "Socket",
        "Stream",
        "getDefaultAutoSelectFamily",
        "setDefaultAutoSelectFamily",
        "getDefaultAutoSelectFamilyAttemptTimeout",
        "setDefaultAutoSelectFamilyAttemptTimeout",
      ].sort(),
    );
    expect(net.Stream).toBe(net.Socket);
  });

  it("classifies IP addresses", () => {
    expect(net.isIP("127.0.0.1")).toBe(4);
    expect(net.isIP("::1")).toBe(6);
    expect(net.isIP("::ffff:10.0.0.1")).toBe(6);
    expect(net.isIP("fe80::1%eth0")).toBe(6);
    expect(net.isIP("localhost")).toBe(0);
    expect(net.isIP("256.0.0.1")).toBe(0);
    expect(net.isIPv4("1.2.3.4")).toBe(true);
    expect(net.isIPv6("1.2.3.4")).toBe(false);
  });

  it("keeps the auto-select family defaults", () => {
    expect(net.getDefaultAutoSelectFamily()).toBe(true);
    net.setDefaultAutoSelectFamily(false);
    expect(net.getDefaultAutoSelectFamily()).toBe(false);
    net.setDefaultAutoSelectFamily(true);
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(250);
    net.setDefaultAutoSelectFamilyAttemptTimeout(5);
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(10);
    net.setDefaultAutoSelectFamilyAttemptTimeout(250);
    expect(() => net.setDefaultAutoSelectFamily("x" as unknown as boolean)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("SocketAddress validates and parses", () => {
    const address = new SocketAddress({ address: "::1", family: "ipv6", port: 80 });
    expect(address.toJSON()).toEqual({ address: "::1", port: 80, family: "ipv6", flowlabel: 0 });
    expect(new SocketAddress().address).toBe("127.0.0.1");
    expect(SocketAddress.isSocketAddress(address)).toBe(true);
    expect(() => new SocketAddress({ address: "nope" })).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ADDRESS" }),
    );
    expect(SocketAddress.parse("1.2.3.4:5")?.toJSON()).toEqual({
      address: "1.2.3.4",
      port: 5,
      family: "ipv4",
      flowlabel: 0,
    });
    expect(SocketAddress.parse("[::1]:8080")?.port).toBe(8080);
  });

  it("BlockList matches addresses, ranges and subnets", () => {
    const list = new BlockList();
    list.addAddress("10.0.0.1");
    list.addRange("10.0.0.10", "10.0.0.20");
    list.addSubnet("192.168.0.0", 16);
    list.addSubnet("8592:757c:efae:4e45::", 64, "ipv6");
    expect(list.check("10.0.0.1")).toBe(true);
    expect(list.check("10.0.0.15")).toBe(true);
    expect(list.check("10.0.0.21")).toBe(false);
    expect(list.check("192.168.44.1")).toBe(true);
    expect(list.check("::ffff:192.168.1.1", "ipv6")).toBe(true);
    expect(list.check("8592:757c:efae:4e45::f", "ipv6")).toBe(true);
    expect(list.check("8592:757c:efae:4e46::f", "ipv6")).toBe(false);
    expect(list.check("not an ip")).toBe(false);
    expect(list.rules).toEqual([
      "Subnet: IPv6 8592:757c:efae:4e45::/64",
      "Subnet: IPv4 192.168.0.0/16",
      "Range: IPv4 10.0.0.10-10.0.0.20",
      "Address: IPv4 10.0.0.1",
    ]);
    expect(BlockList.isBlockList(list)).toBe(true);
  });
});

describe("net servers and sockets", () => {
  it("echoes over a connection, with addresses and byte counts", async () => {
    const server = net.createServer((socket) => {
      socket.pipe(socket);
    });
    const port = await listen(server, 0, "127.0.0.1");
    expect(server.address()).toEqual({ address: "127.0.0.1", family: "IPv4", port });
    const client = net.connect(port, "localhost");
    const closed = once<[boolean]>(client, "close");
    const lookups: unknown[] = [];
    client.on("lookup", (...args: unknown[]) => lookups.push(args));
    expect(client.connecting).toBe(true);
    expect(client.readyState).toBe("opening");
    await once(client, "connect");
    expect(lookups).toEqual([[null, "127.0.0.1", 4, "localhost"]]);
    expect(client.remoteAddress).toBe("127.0.0.1");
    expect(client.remotePort).toBe(port);
    expect(client.remoteFamily).toBe("IPv4");
    expect(client.readyState).toBe("open");
    const received = collect(client);
    client.write("hello ");
    client.end("world");
    expect(await received).toBe("hello world");
    expect(client.bytesWritten).toBe(11);
    expect(client.bytesRead).toBe(11);
    const [hadError] = await closed;
    expect(hadError).toBe(false);
    const serverClosed = once(server, "close");
    server.close();
    await serverClosed;
    expect(fake.refCount).toBe(0);
  });

  it("buffers writes made while connecting", async () => {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      collect(socket).then((text) => socket.end(text.toUpperCase()));
    });
    const port = await listen(server);
    const client = new Socket();
    client.connect({ port });
    client.write("early");
    client.end();
    expect(await collect(client)).toBe("EARLY");
    server.close();
  });

  it("reports the server address as :: / IPv6 by default and maps IPv4 peers", async () => {
    let accepted: Socket | null = null;
    const server = net.createServer((socket) => {
      accepted = socket;
      socket.end();
    });
    const port = await listen(server, 0);
    expect(server.address()).toEqual({ address: "::", family: "IPv6", port });
    const client = net.connect(port);
    client.resume();
    await once(client, "end");
    const socket = accepted as unknown as Socket;
    expect(socket.remoteAddress).toBe("::ffff:127.0.0.1");
    expect(socket.remoteFamily).toBe("IPv6");
    expect(socket.localAddress).toBe("::ffff:127.0.0.1");
    expect(socket.localPort).toBe(port);
    server.close();
  });

  it("emits EADDRINUSE asynchronously with Node's fields", async () => {
    const first = net.createServer();
    const port = await listen(first, 0);
    const second = net.createServer();
    let sync = true;
    const failure = new Promise<Error & Record<string, unknown>>((resolve) => {
      second.on("error", (error) => {
        expect(sync).toBe(false);
        resolve(error as Error & Record<string, unknown>);
      });
    });
    second.listen(port);
    sync = false;
    const error = await failure;
    expect(error.message).toBe(`listen EADDRINUSE: address already in use :::${port}`);
    expect(error).toMatchObject({
      code: "EADDRINUSE",
      errno: -98,
      syscall: "listen",
      address: "::",
      port,
    });
    expect(second.listening).toBe(false);
    first.close();
  });

  it("refuses a connection nobody listens for", async () => {
    const client = net.connect(4321, "127.0.0.1");
    const closed = once(client, "close");
    const [error] = await once<[Error & Record<string, unknown>]>(client, "error");
    expect(error.message).toBe("connect ECONNREFUSED 127.0.0.1:4321");
    expect(error).toMatchObject({
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "127.0.0.1",
      port: 4321,
    });
    await closed;
    expect(fake.refCount).toBe(0);
  });

  it("fails raw TCP to an external host with ENETUNREACH", async () => {
    const client = net.connect(80, "example.com");
    const [error] = await once<[Error & Record<string, unknown>]>(client, "error");
    expect(error.code).toBe("ENETUNREACH");
    expect(error.message).toContain("raw TCP");
    expect(error.syscall).toBe("connect");
  });

  it("validates ports and refuses pipes by name", () => {
    expect(() => net.connect(70000)).toThrow(
      expect.objectContaining({ code: "ERR_SOCKET_BAD_PORT" }),
    );
    expect(() => net.createServer().listen(-1)).toThrow(
      expect.objectContaining({ code: "ERR_SOCKET_BAD_PORT" }),
    );
    expect(() => net.createServer().listen("/tmp/sock")).toThrow(/Unix domain sockets/);
    expect(() => net.connect("/tmp/sock")).toThrow(/Unix domain sockets/);
  });

  it("emits ECONNRESET when the peer vanishes mid-stream", async () => {
    const server = net.createServer((socket) => {
      socket.resetAndDestroy();
    });
    const port = await listen(server, 0);
    const client = net.connect(port);
    const closed = once<[boolean]>(client, "close");
    const [error] = await once<[Error & { code: string }]>(client, "error");
    expect(error.code).toBe("ECONNRESET");
    expect(error.message).toBe("read ECONNRESET");
    const [hadError] = await closed;
    expect(hadError).toBe(true);
    server.close();
  });

  it("sees a plain destroy as the end of the stream", async () => {
    const server = net.createServer((socket) => {
      socket.write("bye");
      socket.destroySoon();
    });
    const port = await listen(server, 0);
    const client = net.connect(port);
    expect(await collect(client)).toBe("bye");
    server.close();
  });

  it("delivers every write made in the same tick before destroy()", async () => {
    const server = net.createServer((socket) => {
      socket.write("A");
      socket.write("B");
      socket.write("C");
      socket.destroy();
    });
    const port = await listen(server, 0);
    const client = net.connect(port);
    expect(await collect(client)).toBe("ABC");
    server.close();
  });

  it("half-open sockets can keep writing after the peer ends", async () => {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("end", () => {
        socket.end("after end");
      });
      socket.resume();
    });
    const port = await listen(server, 0);
    const client = net.connect({ port, allowHalfOpen: true } as never);
    client.end();
    expect(await collect(client)).toBe("after end");
    server.close();
  });

  it("emits timeout after idle time and resets on activity", async () => {
    const server = net.createServer((socket) => {
      socket.resume();
    });
    const port = await listen(server, 0);
    const client = net.connect(port);
    await once(client, "connect");
    const start = Date.now();
    client.setTimeout(30);
    expect(client.timeout).toBe(30);
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.write("x");
    await once(client, "timeout");
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    client.setTimeout(0);
    client.destroy();
    server.close();
  });

  it("counts refs for servers and sockets, honouring unref", async () => {
    const server = net.createServer((socket) => socket.resume());
    const port = await listen(server, 0);
    expect(fake.refCount).toBe(1);
    server.unref();
    expect(fake.refCount).toBe(0);
    server.ref();
    expect(fake.refCount).toBe(1);
    const client = net.connect(port);
    expect(fake.refCount).toBe(2);
    await once(client, "connect");
    await tick();
    expect(fake.refCount).toBe(3);
    client.unref();
    expect(fake.refCount).toBe(2);
    client.ref();
    const closed = once(client, "close");
    client.destroy();
    await closed;
    await tick();
    expect(fake.refCount).toBe(1);
    server.close();
    expect(fake.refCount).toBe(0);
  });

  it("close waits for connections, then calls back; a closed server reports ERR_SERVER_NOT_RUNNING", async () => {
    let accepted: Socket | null = null;
    const server = net.createServer((socket) => {
      accepted = socket;
      socket.resume();
    });
    const port = await listen(server, 0);
    const client = net.connect(port);
    await once(client, "connect");
    await tick();
    let closed = false;
    server.close(() => {
      closed = true;
    });
    expect(server.listening).toBe(false);
    expect(server.address()).toBe(null);
    const counted = await new Promise((resolve) => server.getConnections((_e, n) => resolve(n)));
    expect(counted).toBe(1);
    await tick();
    expect(closed).toBe(false);
    (accepted as unknown as Socket).destroy();
    await tick();
    await tick();
    expect(closed).toBe(true);
    const error = await new Promise((resolve) => server.close(resolve));
    expect(error).toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });
    client.destroy();
  });

  it("throws ERR_SERVER_ALREADY_LISTEN and supports asyncDispose", async () => {
    const server = net.createServer();
    await listen(server, 0);
    expect(() => server.listen(0)).toThrow(
      expect.objectContaining({ code: "ERR_SERVER_ALREADY_LISTEN" }),
    );
    await (server as unknown as Record<symbol, () => Promise<void>>)[Symbol.asyncDispose]();
    expect(server.listening).toBe(false);
  });

  it("drops connections beyond maxConnections", async () => {
    const server = net.createServer((socket) => socket.resume());
    server.maxConnections = 0;
    const drops: unknown[] = [];
    server.on("drop", (info) => drops.push(info));
    const port = await listen(server, 0);
    const client = net.connect(port);
    client.on("error", () => {});
    client.resume();
    await once(client, "close");
    expect(drops).toHaveLength(1);
    server.close();
  });

  it("errors writes after the peer ended without allowHalfOpen", async () => {
    const server = net.createServer((socket) => {
      socket.end();
    });
    const port = await listen(server, 0);
    const client = net.connect(port);
    client.resume();
    await once(client, "end");
    await tick();
    const error = await new Promise((resolve) => client.write("late", resolve));
    expect(error).toMatchObject({ code: "EPIPE" });
    server.close();
  });
});
