import { describe, expect, it } from "vitest";
import { ChannelMux } from "./channels";
import { parseBinaryFrame } from "./frames";
import { RCP_LIMITS } from "./types";

describe("channel mux", () => {
  it("allocates odd client and even agent channel ids", () => {
    const client = new ChannelMux("client", () => {}, () => {});
    const agent = new ChannelMux("agent", () => {}, () => {});
    expect([client.allocate(), client.allocate()]).toEqual([1, 3]);
    expect([agent.allocate(), agent.allocate()]).toEqual([2, 4]);
  });

  it("keeps interleaved channel data separate and closes on FIN", async () => {
    const mux = new ChannelMux("client", () => {}, () => {});
    const first = mux.readable(2).getReader();
    const second = mux.readable(4).getReader();
    mux.receive({ channelId: 4, fin: false, payload: new Uint8Array([4]) });
    mux.receive({ channelId: 2, fin: true, payload: new Uint8Array([2]) });
    expect(await first.read()).toEqual({ done: false, value: new Uint8Array([2]) });
    expect(await first.read()).toEqual({ done: true, value: undefined });
    expect(await second.read()).toEqual({ done: false, value: new Uint8Array([4]) });
  });

  it("blocks a writer after initial credit is exhausted", async () => {
    const frames: Uint8Array[] = [];
    const mux = new ChannelMux("client", (frame) => { frames.push(frame); }, () => {});
    const channel = mux.allocate();
    const writer = mux.writable(channel).getWriter();
    const data = new Uint8Array(RCP_LIMITS.initialChannelCredit + 1);
    let finished = false;
    const write = writer.write(data).then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    expect(frames.reduce((total, frame) => total + parseBinaryFrame(frame).payload.length, 0))
      .toBe(RCP_LIMITS.initialChannelCredit);
    mux.grantCredit(channel, 1);
    await write;
    expect(finished).toBe(true);
  });
});
