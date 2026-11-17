// @vitest-environment node
// The `tls`, `http2` and `https` builtins: their surfaces, the parts that need
// no TLS or HTTP/2 connection, and `https` to this machine as plain HTTP.
import realHttp2 from "node:http2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime } from "../testing/fakeRuntime";
import { Buffer } from "./buffer";
import http from "./http";
import http2 from "./http2";
import https from "./https";
import { Socket } from "./net";
import tls from "./tls";

describe("tls", () => {
  it("has Node 22's exports and constants", () => {
    expect(Object.keys(tls).sort()).toEqual(
      [
        "CLIENT_RENEG_LIMIT",
        "CLIENT_RENEG_WINDOW",
        "DEFAULT_CIPHERS",
        "DEFAULT_ECDH_CURVE",
        "DEFAULT_MIN_VERSION",
        "DEFAULT_MAX_VERSION",
        "getCiphers",
        "rootCertificates",
        "convertALPNProtocols",
        "checkServerIdentity",
        "createSecureContext",
        "SecureContext",
        "TLSSocket",
        "Server",
        "createServer",
        "connect",
      ].sort(),
    );
    expect(tls.DEFAULT_MIN_VERSION).toBe("TLSv1.2");
    expect(tls.DEFAULT_MAX_VERSION).toBe("TLSv1.3");
    expect(tls.DEFAULT_ECDH_CURVE).toBe("auto");
    expect(tls.CLIENT_RENEG_LIMIT).toBe(3);
    expect(tls.CLIENT_RENEG_WINDOW).toBe(600);
    expect(tls.DEFAULT_CIPHERS.startsWith("TLS_AES_256_GCM_SHA384:")).toBe(true);
  });

  it("throws named errors for what needs a TLS implementation", () => {
    expect(() => tls.connect(443, "example.com")).toThrow(
      /tls\.connect is not supported in webnode/,
    );
    expect(() => tls.createServer({})).toThrow(/tls\.createServer is not supported/);
    expect(() => new tls.Server()).toThrow(/tls\.Server is not supported/);
    expect(() => new tls.TLSSocket(new Socket())).toThrow(/TLSSocket\(socket\)/);
  });

  it("throws named errors instead of made-up ciphers, roots or contexts", () => {
    expect(() => tls.getCiphers()).toThrow(/tls\.getCiphers is not supported in webnode/);
    expect(() => tls.rootCertificates).toThrow(/tls\.rootCertificates is not supported/);
    expect(() => tls.createSecureContext({ key: "x" })).toThrow(
      expect.objectContaining({ code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" }),
    );
    expect(() => tls.createSecureContext({})).toThrow(/tls\.createSecureContext is not supported/);
    expect(() => new tls.SecureContext()).toThrow(/tls\.SecureContext is not supported/);
    expect(() => tls.createSecureContext(1 as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("TLSSocket is a net.Socket with encrypted set", () => {
    const socket = new tls.TLSSocket();
    expect(socket).toBeInstanceOf(Socket);
    expect(socket.encrypted).toBe(true);
    expect(socket.getPeerCertificate()).toBe(null);
  });

  it("checks server identity like Node", () => {
    const cert = {
      subject: { CN: "ignored" },
      subjectaltname: "DNS:*.example.com, DNS:example.com, IP Address:127.0.0.1",
    };
    expect(tls.checkServerIdentity("www.example.com", cert)).toBeUndefined();
    expect(tls.checkServerIdentity("example.com.", cert)).toBeUndefined();
    expect(tls.checkServerIdentity("127.0.0.1", cert)).toBeUndefined();
    const mismatch = tls.checkServerIdentity("a.b.example.com", cert) as Error &
      Record<string, unknown>;
    expect(mismatch.message).toBe(
      "Hostname/IP does not match certificate's altnames: Host: a.b.example.com. is not in the cert's altnames: DNS:*.example.com, DNS:example.com, IP Address:127.0.0.1",
    );
    expect(mismatch.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(mismatch.host).toBe("a.b.example.com");
    expect(tls.checkServerIdentity("10.0.0.1", cert)).toMatchObject({
      reason: "IP: 10.0.0.1 is not in the cert's list: 127.0.0.1",
    });
    expect(tls.checkServerIdentity("host.test", { subject: { CN: "host.test" } })).toBeUndefined();
    expect(tls.checkServerIdentity("x.test", {})).toMatchObject({
      reason: "Cert does not contain a DNS name",
    });
  });

  it("converts ALPN protocol lists to their wire form", () => {
    const out: { ALPNProtocols?: unknown } = {};
    tls.convertALPNProtocols(["h2", "http/1.1"], out);
    expect(Buffer.from(out.ALPNProtocols as Uint8Array).toString("latin1")).toBe(
      "\x02h2\x08http/1.1",
    );
  });
});

describe("http2", () => {
  it("has Node 22's exports and constants table", () => {
    expect(Object.keys(http2).sort()).toEqual(
      [
        "connect",
        "constants",
        "createServer",
        "createSecureServer",
        "getDefaultSettings",
        "getPackedSettings",
        "getUnpackedSettings",
        "performServerHandshake",
        "sensitiveHeaders",
        "Http2ServerRequest",
        "Http2ServerResponse",
      ].sort(),
    );
    expect(http2.constants).toEqual({ ...realHttp2.constants });
    expect(typeof http2.sensitiveHeaders).toBe("symbol");
  });

  it("packs and unpacks SETTINGS exactly as Node does", () => {
    const settings = {
      headerTableSize: 1,
      enablePush: false,
      maxConcurrentStreams: 3,
      initialWindowSize: 4,
      maxFrameSize: 16385,
      maxHeaderListSize: 6,
      enableConnectProtocol: true,
    };
    const packed = http2.getPackedSettings(settings);
    expect(Buffer.from(packed).toString("hex")).toBe(
      Buffer.from(realHttp2.getPackedSettings(settings)).toString("hex"),
    );
    expect(http2.getUnpackedSettings(packed)).toEqual(realHttp2.getUnpackedSettings(packed));
    expect(http2.getUnpackedSettings(Buffer.from([0, 9, 0, 0, 0, 1]))).toEqual({
      customSettings: { 9: 1 },
    });
    expect(http2.getDefaultSettings()).toEqual(realHttp2.getDefaultSettings());
    expect(() => http2.getPackedSettings({ maxFrameSize: 1 })).toThrow(
      'Invalid value for setting "maxFrameSize": 1',
    );
    expect(() => http2.getPackedSettings({ enablePush: 1 as never })).toThrow(TypeError);
    expect(() => http2.getUnpackedSettings(Buffer.from([0, 1, 0]))).toThrow(
      expect.objectContaining({ code: "ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH" }),
    );
  });

  it("throws named errors for connections and servers", () => {
    expect(() => http2.connect("https://example.com")).toThrow(/http2\.connect is not supported/);
    expect(() => http2.createServer()).toThrow(/http2\.createServer is not supported/);
    expect(() => http2.createSecureServer()).toThrow(/http2\.createSecureServer is not supported/);
  });
});

describe("https to this machine", () => {
  beforeEach(() => {
    setRuntime(createFakeRuntime());
  });

  afterEach(() => {
    https.globalAgent.destroy();
    setRuntime(null);
  });

  it("is plain HTTP to the in-runtime server, with an https Agent", async () => {
    expect(Object.keys(https).sort()).toEqual(
      ["Agent", "globalAgent", "Server", "createServer", "get", "request"].sort(),
    );
    expect(https.globalAgent.defaultPort).toBe(443);
    expect(https.globalAgent.protocol).toBe("https:");
    const server = https.createServer({ key: "unused", cert: "unused" }, (req, res) => {
      res.end(`secure? ${req.url}`);
    });
    expect(server).toBeInstanceOf(http.Server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get(`https://localhost:${port}/x`, (res) => {
          let text = "";
          res.on("data", (chunk) => (text += String(chunk)));
          res.on("end", () => resolve(text));
        })
        .on("error", reject);
    });
    expect(body).toBe("secure? /x");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
});
