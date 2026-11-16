// @vitest-environment node
import { describe, expect, it } from "vitest";
import cluster from "./cluster";
import dgram from "./dgram";
import domain from "./domain";
import EventEmitter from "./events";
import inspector from "./inspector";
import repl from "./repl";
import sys from "./sys";
import traceEvents from "./trace_events";
import util from "./util";

const unavailable = (text: string) =>
  expect.objectContaining({ message: expect.stringContaining(text) as unknown });

describe("cluster", () => {
  it("is the primary and cannot fork", () => {
    expect(cluster).toBeInstanceOf(EventEmitter);
    expect(cluster.isPrimary).toBe(true);
    expect(cluster.isMaster).toBe(true);
    expect(cluster.isWorker).toBe(false);
    expect(cluster.workers).toEqual({});
    expect([cluster.SCHED_NONE, cluster.SCHED_RR]).toEqual([1, 2]);
    expect(() => cluster.fork()).toThrow(unavailable("cluster.fork is not available in webnode"));
    expect(() => cluster.setupPrimary()).toThrow(unavailable("cluster.setupPrimary"));
    expect(() => cluster.disconnect()).toThrow(unavailable("cluster.disconnect"));
    const seen: unknown[] = [];
    cluster.on("x", (v) => seen.push(v));
    cluster.emit("x", 1);
    expect(seen).toEqual([1]);
  });
});

describe("dgram", () => {
  it("cannot create sockets", () => {
    expect(() => dgram.createSocket("udp4")).toThrow(
      unavailable("dgram.createSocket is not available in webnode"),
    );
    expect(() => new dgram.Socket()).toThrow(unavailable("dgram.Socket"));
  });
});

describe("domain", () => {
  it("emits errors thrown inside run and tracks the active domain", () => {
    const d = domain.create();
    const errors: unknown[] = [];
    d.on("error", (error) => errors.push(error));
    expect(domain.active).toBe(null);
    const result = d.run((a: unknown) => {
      expect(domain.active).toBe(d);
      return a;
    }, 5);
    expect(result).toBe(5);
    d.run(() => {
      throw new Error("inside");
    });
    expect((errors[0] as Error).message).toBe("inside");
    expect((errors[0] as { domain: unknown }).domain).toBe(d);
    expect(domain.active).toBe(null);
  });

  it("binds and intercepts callbacks", () => {
    const d = domain.create();
    const errors: unknown[] = [];
    d.on("error", (error) => errors.push(error));
    const bound = d.bind((x: unknown) => {
      if (x === "throw") {
        throw new Error("bound");
      }
      return x;
    });
    expect(bound(1)).toBe(1);
    bound("throw");
    const intercepted = d.intercept((value: unknown) => value);
    expect(intercepted(null, "ok")).toBe("ok");
    intercepted(new Error("first arg"));
    expect(errors.map((e) => (e as Error).message)).toEqual(["bound", "first arg"]);
  });

  it("adds and removes members and nests enter/exit", () => {
    const a = domain.create();
    const b = domain.create();
    const emitter = new EventEmitter();
    a.add(emitter);
    expect((emitter as unknown as { domain: unknown }).domain).toBe(a);
    b.add(emitter);
    expect(a.members).toEqual([]);
    expect(b.members).toEqual([emitter]);
    b.remove(emitter);
    expect(b.members).toEqual([]);
    a.enter();
    b.enter();
    expect(domain.active).toBe(b);
    a.exit();
    expect(domain.active).toBe(null);
    expect(domain._stack).toEqual([]);
  });

  it("rethrows when nobody listens for error", () => {
    const d = domain.create();
    expect(() =>
      d.run(() => {
        throw new Error("unheard");
      }),
    ).toThrow("unheard");
  });
});

describe("inspector", () => {
  it("is never active", () => {
    expect(inspector.url()).toBeUndefined();
    expect(() => inspector.close()).not.toThrow();
    expect(() => inspector.open()).toThrow(unavailable("inspector.open is not available"));
    expect(() => inspector.waitForDebugger()).toThrow(
      expect.objectContaining({ code: "ERR_INSPECTOR_NOT_ACTIVE" }),
    );
    expect(inspector.console).toBe(console);
    const session = new inspector.Session();
    expect(() => session.connect()).toThrow(unavailable("inspector.Session.connect"));
    expect(() => inspector.Network.requestWillBeSent({})).not.toThrow();
  });
});

describe("repl", () => {
  it("cannot start but lists the builtins", () => {
    expect(() => repl.start()).toThrow(unavailable("repl.start is not available in webnode"));
    expect(() => new repl.REPLServer()).toThrow(unavailable("repl.REPLServer"));
    expect(repl.builtinModules).toContain("fs");
    expect(repl.builtinModules).toContain("readline/promises");
    expect(repl.builtinModules.some((name) => name.startsWith("_"))).toBe(false);
    expect(repl.builtinModules.some((name) => name.startsWith("node:"))).toBe(false);
  });
});

describe("trace_events", () => {
  it("creates inert tracing objects", () => {
    const tracing = traceEvents.createTracing({ categories: ["node", "v8"] });
    tracing.enable();
    expect(tracing.enabled).toBe(false);
    expect(tracing.categories).toBe("node,v8");
    tracing.disable();
    expect(traceEvents.getEnabledCategories()).toBeUndefined();
    expect(() => traceEvents.createTracing({ categories: [] })).toThrow(
      expect.objectContaining({ code: "ERR_TRACE_EVENTS_CATEGORY_REQUIRED" }),
    );
    expect(() => traceEvents.createTracing({})).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });
});

describe("sys", () => {
  it("sys is util", () => {
    expect(sys).toBe(util);
  });
});
