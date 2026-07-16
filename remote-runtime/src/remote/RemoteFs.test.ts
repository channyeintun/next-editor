import { describe, expect, it } from "vitest";
import { ChannelMux } from "../rcp/channels";
import { RemoteFs } from "./RemoteFs";

describe("RemoteFs compatibility", () => {
  it("supports WebContainer buffer encodings and buffered directory names", async () => {
    const mux = new ChannelMux("client", () => {}, () => {});
    let nextChannel = 2;
    const connection = {
      channels: mux,
      onReconnect: () => () => {},
      request: async (method: string) => {
        if (method === "fs.readFile") {
          const ch = nextChannel;
          nextChannel += 2;
          setTimeout(() => mux.receive({
            channelId: ch,
            fin: true,
            payload: new Uint8Array([0, 0xff, 0x10]),
          }), 0);
          return { ch };
        }
        if (method === "fs.readdir") {
          return { entries: [{ name: "héllo.txt", kind: "file" }] };
        }
        return {};
      },
    };
    const fs = new RemoteFs(connection as never);

    await expect(fs.readFile("file", "hex")).resolves.toBe("00ff10");
    await expect(fs.readFile("file", "base64url")).resolves.toBe("AP8Q");
    const entries = await fs.readdir(".", { encoding: "buffer", withFileTypes: true });
    expect(new TextDecoder().decode(entries[0]!.name)).toBe("héllo.txt");
    expect(entries[0]!.isFile()).toBe(true);
  });
});
