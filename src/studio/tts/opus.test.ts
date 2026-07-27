import { describe, expect, it } from "vite-plus/test";
import { muxOggOpus, oggCrc32 } from "./opus";

/**
 * The Ogg container is hand-written, so these tests demux it back rather than
 * trusting the writer: every assertion below is what a real decoder reads.
 */

interface ParsedPage {
  headerType: number;
  granulePosition: number;
  serial: number;
  sequence: number;
  crcOk: boolean;
  packets: Uint8Array[];
}

function parseOgg(stream: Uint8Array): ParsedPage[] {
  const pages: ParsedPage[] = [];
  let offset = 0;

  while (offset < stream.length) {
    const view = new DataView(stream.buffer, stream.byteOffset + offset, stream.length - offset);
    expect(String.fromCharCode(...stream.subarray(offset, offset + 4))).toBe("OggS");

    const segmentCount = stream[offset + 26];
    const lacings = stream.subarray(offset + 27, offset + 27 + segmentCount);
    const payloadStart = offset + 27 + segmentCount;
    const payloadBytes = lacings.reduce((total, value) => total + value, 0);
    const pageBytes = stream.subarray(offset, payloadStart + payloadBytes);

    // Recompute the checksum over the page with its CRC field zeroed, exactly
    // as a demuxer does.
    const zeroed = pageBytes.slice();
    new DataView(zeroed.buffer).setUint32(22, 0, true);

    const packets: Uint8Array[] = [];
    let packetStart = payloadStart;
    let packetBytes = 0;
    for (const lacing of lacings) {
      packetBytes += lacing;
      if (lacing < 255) {
        packets.push(stream.subarray(packetStart, packetStart + packetBytes));
        packetStart += packetBytes;
        packetBytes = 0;
      }
    }

    pages.push({
      headerType: stream[offset + 5],
      granulePosition: view.getUint32(6, true) + view.getUint32(10, true) * 0x1_0000_0000,
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      crcOk: oggCrc32(zeroed) === view.getUint32(22, true),
      packets,
    });
    offset = payloadStart + payloadBytes;
  }

  return pages;
}

function packetsOf(count: number, byteLength = 80): Uint8Array[] {
  return Array.from({ length: count }, (_unused, index) =>
    Uint8Array.from({ length: byteLength }, (_byte, position) => (index + position) & 0xff),
  );
}

const stream = {
  preSkip: 312,
  inputSampleRate: 48_000,
  channelCount: 1,
  totalSamples: 48_000,
};

describe("Ogg/Opus muxer", () => {
  it("writes a demuxable stream whose headers a decoder can act on", () => {
    const packets = packetsOf(3);
    const pages = parseOgg(muxOggOpus({ ...stream, packets }));

    expect(pages).toHaveLength(3);
    expect(pages.every((page) => page.crcOk)).toBe(true);
    expect(pages.map((page) => page.sequence)).toEqual([0, 1, 2]);
    expect(new Set(pages.map((page) => page.serial)).size).toBe(1);

    const head = pages[0].packets[0];
    expect(String.fromCharCode(...head.subarray(0, 8))).toBe("OpusHead");
    expect(pages[0].headerType).toBe(0x02); // begin of stream
    const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
    expect(head[8]).toBe(1); // encapsulation version
    expect(head[9]).toBe(1); // mono
    expect(headView.getUint16(10, true)).toBe(312); // pre-skip
    expect(headView.getUint32(12, true)).toBe(48_000);
    expect(head[18]).toBe(0); // channel mapping family

    expect(String.fromCharCode(...pages[1].packets[0].subarray(0, 8))).toBe("OpusTags");
    expect(pages[1].headerType).toBe(0);

    // The audio page ends the stream and its granule position is the trim
    // target — pre-skip plus one second — not the padded packet count.
    expect(pages[2].headerType).toBe(0x04); // end of stream
    expect(pages[2].granulePosition).toBe(312 + 48_000);
    expect(pages[2].packets.map((packet) => [...packet])).toEqual(packets.map((p) => [...p]));
  });

  it("splits audio across pages at Ogg's 255-segment limit", () => {
    const packets = packetsOf(600);
    const pages = parseOgg(muxOggOpus({ ...stream, packets, totalSamples: 600 * 960 }));

    const audioPages = pages.slice(2);
    expect(audioPages.length).toBeGreaterThan(1);
    expect(audioPages.every((page) => page.packets.length <= 255)).toBe(true);
    expect(pages.every((page) => page.crcOk)).toBe(true);
    expect(pages.map((page) => page.sequence)).toEqual(pages.map((_page, index) => index));

    // No packet may be dropped or reordered by the page grouping.
    expect(audioPages.flatMap((page) => page.packets).length).toBe(600);

    // Granule positions must never go backwards, and only the last page is EOS.
    const granules = audioPages.map((page) => page.granulePosition);
    expect(granules).toEqual([...granules].sort((left, right) => left - right));
    expect(audioPages.map((page) => page.headerType)).toEqual(
      audioPages.map((_page, index) => (index === audioPages.length - 1 ? 0x04 : 0)),
    );
  });

  it("terminates a 255-byte-multiple packet with an explicit zero lacing", () => {
    // Without the trailing 0 segment a demuxer would run this packet into the
    // next one, so the length that exercises it gets its own case.
    const packets = [packetsOf(1, 510)[0], packetsOf(1, 80)[0]];
    const pages = parseOgg(muxOggOpus({ ...stream, packets, totalSamples: 2 * 960 }));

    expect(pages[2].packets.map((packet) => packet.length)).toEqual([510, 80]);
    expect(pages.every((page) => page.crcOk)).toBe(true);
  });

  it("refuses an empty stream rather than writing a headers-only file", () => {
    expect(() => muxOggOpus({ ...stream, packets: [] })).toThrow(/at least one audio packet/);
  });
});
