// ============================================================================
// Whisper's tokenizer: GPT-2 byte-level BPE, read from the model's
// tokenizer.json. Token ids become caption text; a prompt (the lesson's
// vocabulary) becomes token ids.
// ============================================================================

interface TokenizerJson {
  model: { vocab: Record<string, number>; merges?: string[] };
  added_tokens: Array<{ id: number; content: string; special?: boolean }>;
}

/** GPT-2's pre-tokenizer: text is split into these pieces before BPE runs on each. */
const GPT2_PIECES = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/** GPT-2's bytes_to_unicode: the printable character each byte is written as in the vocabulary. */
function createByteEncoder(): string[] {
  const bytes: number[] = [];
  const add = (from: number, to: number) => {
    for (let byte = from; byte <= to; byte++) bytes.push(byte);
  };
  add("!".charCodeAt(0), "~".charCodeAt(0));
  add("¡".charCodeAt(0), "¬".charCodeAt(0));
  add("®".charCodeAt(0), "ÿ".charCodeAt(0));
  const codePoints = [...bytes];
  let extra = 0;
  for (let byte = 0; byte < 256; byte++) {
    if (!bytes.includes(byte)) {
      bytes.push(byte);
      codePoints.push(256 + extra);
      extra++;
    }
  }
  const encoder: string[] = [];
  bytes.forEach((byte, index) => {
    encoder[byte] = String.fromCodePoint(codePoints[index]);
  });
  return encoder;
}

export class WhisperTokenizer {
  private readonly tokens: string[] = [];
  private readonly ids = new Map<string, number>();
  private readonly byteEncoder = createByteEncoder();
  private readonly byteDecoder = new Map(
    this.byteEncoder.map((character, byte) => [character, byte] as const),
  );
  private readonly mergeRanks = new Map<string, number>();
  private readonly textDecoder = new TextDecoder("utf-8");
  private readonly textEncoder = new TextEncoder();
  /** Ids at or above this are special (end of text, languages, tasks, timestamps). */
  readonly firstSpecialId: number;

  constructor(json: TokenizerJson) {
    for (const [token, id] of Object.entries(json.model.vocab)) {
      this.tokens[id] = token;
      this.ids.set(token, id);
    }
    let firstSpecial = Infinity;
    for (const added of json.added_tokens) {
      this.tokens[added.id] = added.content;
      this.ids.set(added.content, added.id);
      firstSpecial = Math.min(firstSpecial, added.id);
    }
    this.firstSpecialId = firstSpecial;
    json.model.merges?.forEach((merge, rank) => this.mergeRanks.set(merge, rank));
  }

  /**
   * Token ids for `text`: GPT-2's pieces, each byte-mapped and merged pair by pair in
   * merge-rank order. Used for prompts, which are short.
   */
  encode(text: string): number[] {
    const ids: number[] = [];
    for (const match of text.matchAll(GPT2_PIECES)) {
      const piece = Array.from(this.textEncoder.encode(match[0]), (byte) => this.byteEncoder[byte]);
      for (const token of this.mergePiece(piece)) {
        const id = this.ids.get(token);
        if (id !== undefined) ids.push(id);
      }
    }
    return ids;
  }

  private mergePiece(parts: string[]): string[] {
    let merged = parts;
    while (merged.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let index = 0; index < merged.length - 1; index++) {
        const rank = this.mergeRanks.get(`${merged[index]} ${merged[index + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = index;
        }
      }
      if (best < 0) break;
      merged = [
        ...merged.slice(0, best),
        merged[best] + merged[best + 1],
        ...merged.slice(best + 2),
      ];
    }
    return merged;
  }

  /** The id of a token by its text (`<|en|>`, `<|0.00|>`), if the vocabulary has it. */
  idOf(token: string): number | undefined {
    return this.ids.get(token);
  }

  tokenOf(id: number): string | undefined {
    return this.tokens[id];
  }

  /** The text of ordinary tokens; special ones (timestamps included) are skipped. */
  decode(ids: readonly number[]): string {
    const bytes: number[] = [];
    for (const id of ids) {
      if (id >= this.firstSpecialId) continue;
      const token = this.tokens[id];
      if (token === undefined) continue;
      for (const character of token) {
        const byte = this.byteDecoder.get(character);
        if (byte !== undefined) bytes.push(byte);
      }
    }
    return this.textDecoder.decode(new Uint8Array(bytes));
  }
}
