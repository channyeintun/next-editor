import { decodeWavPcm16 } from "./wav";

/**
 * Ogg/Opus encoding for the finished narration track.
 *
 * Synthesis works in PCM16 WAV because stitching dialogs at exact sample
 * offsets has to stay a byte-level operation (see wav.ts). That format is wrong
 * for the published artifact: 48 kHz mono PCM16 costs 96 KB/s no matter what it
 * carries — silence between dialogs is stored as literal zero samples — so a
 * 25-minute lesson is ~144 MB. That is past Cloudflare's 100 MB request-body
 * cap on the upload PUT (the Worker's own limit never gets a say), and it is a
 * download every viewer would pay. Opus at 32 kbps is transparent for speech
 * and lands the same narration around 6 MB.
 *
 * WebCodecs does the encoding: it runs far faster than realtime, where
 * MediaRecorder is stream-bound and would take as long as the lesson runs. It
 * emits bare Opus packets though, so the Ogg container is assembled here.
 */

export const OGG_OPUS_MIME = "audio/ogg";

/** Opus always decodes at 48 kHz, and Ogg granule positions are in those units. */
const OPUS_DECODE_RATE = 48_000;
const OPUS_FRAME_DURATION_US = 20_000;
const OPUS_SAMPLES_PER_PACKET = (OPUS_DECODE_RATE * OPUS_FRAME_DURATION_US) / 1_000_000;

/** Transparent for a single speaking voice; the track is mono narration. */
const NARRATION_BITRATE = 32_000;

/** libopus' default lookahead, used only if the encoder withholds its OpusHead. */
const DEFAULT_PRE_SKIP = 312;

/**
 * Ogg serial numbers only have to be unique among streams multiplexed into one
 * file, and narration is always a single stream — so this is fixed rather than
 * random, which keeps repeat renders of the same lesson byte-identical.
 */
const NARRATION_SERIAL = 0x4e45_5854; // "NEXT"

const OGG_MAX_SEGMENTS_PER_PAGE = 255;
const OGG_HEADER_BYTES = 27;
const OGG_FLAG_BEGIN_OF_STREAM = 0x02;
const OGG_FLAG_END_OF_STREAM = 0x04;
const OGG_CRC_POLYNOMIAL = 0x04c1_1db7;

const OGG_CAPTURE_PATTERN = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const OPUS_HEAD_MAGIC = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"
const OPUS_TAGS_MAGIC = [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]; // "OpusTags"

/**
 * Ogg's CRC is its own variant: polynomial 0x04c11db7 applied MSB-first with no
 * input/output reflection and no final inversion, so the usual zlib-style table
 * does not apply.
 */
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let remainder = index << 24;
    for (let bit = 0; bit < 8; bit++) {
      remainder =
        (remainder & 0x8000_0000) !== 0
          ? ((remainder << 1) ^ OGG_CRC_POLYNOMIAL) >>> 0
          : (remainder << 1) >>> 0;
    }
    table[index] = remainder;
  }
  return table;
})();

export function oggCrc32(page: Uint8Array): number {
  let crc = 0;
  for (const byte of page) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  }
  return crc;
}

/**
 * Ogg lacing: a packet is written as as many 255-byte segments as it needs plus
 * a shorter final one. A length that is an exact multiple of 255 therefore ends
 * in an explicit 0, which is what tells the demuxer the packet stopped there.
 */
function lacingFor(packet: Uint8Array): number[] {
  const values: number[] = [];
  let remaining = packet.length;
  while (remaining >= 255) {
    values.push(255);
    remaining -= 255;
  }
  values.push(remaining);
  return values;
}

function writeOggPage(input: {
  packets: readonly Uint8Array[];
  granulePosition: number;
  headerType: number;
  sequence: number;
  serial: number;
}): Uint8Array {
  const lacings = input.packets.flatMap(lacingFor);
  const payloadBytes = input.packets.reduce((total, packet) => total + packet.length, 0);
  const page = new Uint8Array(OGG_HEADER_BYTES + lacings.length + payloadBytes);
  const view = new DataView(page.buffer);

  page.set(OGG_CAPTURE_PATTERN, 0);
  page[4] = 0; // stream structure version
  page[5] = input.headerType;
  // Granule position is 64-bit. Narration never approaches 2^53 samples (that
  // is over 5000 years at 48 kHz), so a split of the JS number is exact.
  view.setUint32(6, input.granulePosition >>> 0, true);
  view.setUint32(10, Math.floor(input.granulePosition / 0x1_0000_0000), true);
  view.setUint32(14, input.serial, true);
  view.setUint32(18, input.sequence, true);
  view.setUint32(22, 0, true); // CRC is computed over the page with this field zeroed
  page[26] = lacings.length;
  page.set(lacings, OGG_HEADER_BYTES);

  let offset = OGG_HEADER_BYTES + lacings.length;
  for (const packet of input.packets) {
    page.set(packet, offset);
    offset += packet.length;
  }

  view.setUint32(22, oggCrc32(page), true);
  return page;
}

function opusHead(channelCount: number, preSkip: number, inputSampleRate: number): Uint8Array {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(OPUS_HEAD_MAGIC, 0);
  head[8] = 1; // encapsulation version
  head[9] = channelCount;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family 0
  return head;
}

function opusTags(vendor: string): Uint8Array {
  const vendorBytes = new TextEncoder().encode(vendor);
  const tags = new Uint8Array(OPUS_TAGS_MAGIC.length + 4 + vendorBytes.length + 4);
  const view = new DataView(tags.buffer);
  tags.set(OPUS_TAGS_MAGIC, 0);
  view.setUint32(8, vendorBytes.length, true);
  tags.set(vendorBytes, 12);
  view.setUint32(12 + vendorBytes.length, 0, true); // zero user comments
  return tags;
}

export interface OggOpusStream {
  /** Raw Opus packets in encode order. */
  packets: readonly Uint8Array[];
  /** Encoder lookahead the decoder must discard, in 48 kHz samples. */
  preSkip: number;
  /** Original PCM rate — informational per RFC 7845; Opus decodes at 48 kHz. */
  inputSampleRate: number;
  channelCount: number;
  /** Samples to keep, in 48 kHz units, so the encoder's padded tail is trimmed. */
  totalSamples: number;
}

/** Wrap encoded Opus packets in an Ogg stream (RFC 3533 pages, RFC 7845 headers). */
export function muxOggOpus({
  packets,
  preSkip,
  inputSampleRate,
  channelCount,
  totalSamples,
}: OggOpusStream): Uint8Array {
  if (packets.length === 0) {
    throw new Error("An Ogg/Opus stream needs at least one audio packet");
  }

  const serial = NARRATION_SERIAL;
  const pages: Uint8Array[] = [
    writeOggPage({
      packets: [opusHead(channelCount, preSkip, inputSampleRate)],
      granulePosition: 0,
      headerType: OGG_FLAG_BEGIN_OF_STREAM,
      sequence: 0,
      serial,
    }),
    writeOggPage({
      packets: [opusTags("next-editor studio")],
      granulePosition: 0,
      headerType: 0,
      sequence: 1,
      serial,
    }),
  ];

  // Group packets under Ogg's 255-segment page limit without ever splitting one
  // across a page boundary. Every page then ends on a completed packet, which
  // is what lets its granule position be the plain running sample count.
  const grouped: Uint8Array[][] = [];
  let current: Uint8Array[] = [];
  let segments = 0;
  for (const packet of packets) {
    const needed = lacingFor(packet).length;
    if (needed > OGG_MAX_SEGMENTS_PER_PAGE) {
      throw new Error(`Opus packet of ${packet.length} bytes cannot fit one Ogg page`);
    }
    if (segments + needed > OGG_MAX_SEGMENTS_PER_PAGE && current.length > 0) {
      grouped.push(current);
      current = [];
      segments = 0;
    }
    current.push(packet);
    segments += needed;
  }
  if (current.length > 0) {
    grouped.push(current);
  }

  // The final page's granule position is where the decoder stops, so it carries
  // the exact sample count rather than the encoder's zero-padded last frame.
  const finalGranule = preSkip + totalSamples;
  let decoded = 0;
  for (const [index, group] of grouped.entries()) {
    decoded += group.length * OPUS_SAMPLES_PER_PACKET;
    const isLast = index === grouped.length - 1;
    pages.push(
      writeOggPage({
        packets: group,
        // Clamped so the sequence stays non-decreasing even when the encoder
        // emitted more padding than the trim target accounts for.
        granulePosition: isLast ? finalGranule : Math.min(decoded, finalGranule),
        headerType: isLast ? OGG_FLAG_END_OF_STREAM : 0,
        sequence: index + 2,
        serial,
      }),
    );
  }

  const stream = new Uint8Array(pages.reduce((total, page) => total + page.length, 0));
  let offset = 0;
  for (const page of pages) {
    stream.set(page, offset);
    offset += page.length;
  }
  return stream;
}

function preSkipFromOpusHead(description: AllowSharedBufferSource): number | null {
  const view = ArrayBuffer.isView(description)
    ? new DataView(description.buffer, description.byteOffset, description.byteLength)
    : new DataView(description);
  // "OpusHead" magic (8) + version (1) + channels (1) then the pre-skip pair.
  return view.byteLength < 12 ? null : view.getUint16(10, true);
}

/**
 * Hold at most this many one-second buffers in the encoder's queue. A
 * 25-minute narration is ~1500 of them; handing over all of them at once would
 * keep the whole decoded track resident while Opus chews through it.
 */
const ENCODE_QUEUE_LIMIT = 16;

async function awaitEncoderCapacity(encoder: AudioEncoder): Promise<void> {
  while (encoder.encodeQueueSize > ENCODE_QUEUE_LIMIT) {
    // Subscribe before re-reading the size: a dequeue landing between the read
    // and the subscription would otherwise leave this waiting forever.
    const dequeued = new Promise<void>((resolve) => {
      encoder.addEventListener("dequeue", () => resolve(), { once: true });
    });
    if (encoder.encodeQueueSize <= ENCODE_QUEUE_LIMIT) {
      return;
    }
    await dequeued;
  }
}

/** Transcode a stitched PCM16 mono WAV narration track into Ogg/Opus. */
export async function encodeWavToOggOpus(
  wavBytes: Uint8Array,
  options: { bitrate?: number; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  if (typeof AudioEncoder === "undefined") {
    throw new Error(
      "This browser has no WebCodecs AudioEncoder, so the narration cannot be encoded to Opus",
    );
  }

  const { pcm, sampleRate } = decodeWavPcm16(wavBytes);
  if (pcm.length === 0) {
    throw new Error("The narration track is empty");
  }

  const config: AudioEncoderConfig = {
    codec: "opus",
    sampleRate,
    numberOfChannels: 1,
    bitrate: options.bitrate ?? NARRATION_BITRATE,
    opus: { frameDuration: OPUS_FRAME_DURATION_US },
  };
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error(`This browser cannot encode Opus at ${sampleRate} Hz`);
  }

  const packets: Uint8Array[] = [];
  let preSkip: number | null = null;
  let failure: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      // Chrome hands back the OpusHead it built alongside the first chunk, so
      // the real encoder delay is read from there instead of assumed.
      const description = metadata?.decoderConfig?.description;
      if (preSkip === null && description) {
        preSkip = preSkipFromOpusHead(description);
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push(bytes);
    },
    error: (error: DOMException) => {
      failure ??= error;
    },
  });
  encoder.configure(config);

  try {
    const framesPerChunk = sampleRate; // one second per AudioData
    for (let offset = 0; offset < pcm.length; offset += framesPerChunk) {
      if (failure) throw failure;
      options.signal?.throwIfAborted();

      const frames = Math.min(framesPerChunk, pcm.length - offset);
      const samples = new Float32Array(frames);
      for (let index = 0; index < frames; index++) {
        samples[index] = pcm[offset + index] / 0x8000;
      }

      const data = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: 1,
        timestamp: Math.round((offset / sampleRate) * 1_000_000),
        data: samples,
      });
      encoder.encode(data);
      data.close();

      await awaitEncoderCapacity(encoder);
    }
    await encoder.flush();
  } finally {
    encoder.close();
  }

  if (failure) throw failure;

  return muxOggOpus({
    packets,
    preSkip: preSkip ?? DEFAULT_PRE_SKIP,
    inputSampleRate: sampleRate,
    channelCount: 1,
    totalSamples: Math.round((pcm.length / sampleRate) * OPUS_DECODE_RATE),
  });
}
