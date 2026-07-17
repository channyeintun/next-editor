import { describe, expect, it } from "vitest";
import { ChannelMux } from "../rcp/channels";
import { RemoteProcess } from "./RemoteProcess";

describe("RemoteProcess", () => {
  it("preserves UTF-8 codepoints split across output frames", async () => {
    const mux = new ChannelMux(
      "client",
      () => {},
      () => {},
    );
    const listeners = new Map<string, (event: never) => void>();
    const connection = {
      channels: mux,
      on: (name: string, listener: (event: never) => void) => {
        listeners.set(name, listener);
        return () => {};
      },
      request: async () => ({}),
    };
    const process = new RemoteProcess(connection as never, 1, 2, 3);
    const reader = process.output.getReader();
    mux.receive({ channelId: 2, fin: false, payload: new Uint8Array([0xc3]) });
    mux.receive({ channelId: 2, fin: true, payload: new Uint8Array([0xa9]) });
    expect(await reader.read()).toEqual({ done: false, value: "é" });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });
});
