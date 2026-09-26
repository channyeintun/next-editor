import { describe, expect, it } from "vite-plus/test";
import { WhisperTokenizer } from "./whisperTokenizer";

/** GPT-2's byte-to-character table, rebuilt independently of the tokenizer. */
function byteCharacters(): string[] {
  const printable = [
    ...Array.from({ length: 94 }, (_, index) => 33 + index),
    ...Array.from({ length: 12 }, (_, index) => 161 + index),
    ...Array.from({ length: 82 }, (_, index) => 174 + index),
  ];
  const characters: string[] = [];
  let extra = 0;
  for (let byte = 0; byte < 256; byte++) {
    characters[byte] = String.fromCodePoint(printable.includes(byte) ? byte : 256 + extra++);
  }
  return characters;
}

/**
 * A miniature Whisper vocabulary: every byte as a token, a few merges (so " hello"
 * becomes one token), and special tokens after them.
 */
function miniTokenizer() {
  const vocab: Record<string, number> = {};
  byteCharacters().forEach((character, byte) => {
    vocab[character] = byte;
  });
  const merges = ["h e", "l l", "he ll", "hell o", "Ġ hello", "Ġ w", "Ġw o"];
  let next = 256;
  for (const merge of merges) vocab[merge.replace(" ", "")] = next++;
  return new WhisperTokenizer({
    model: { vocab, merges },
    added_tokens: [
      { id: 300, content: "<|endoftext|>", special: true },
      { id: 301, content: "<|startoftranscript|>", special: true },
      { id: 302, content: "<|0.00|>", special: true },
    ],
  });
}

describe("WhisperTokenizer", () => {
  it("merges pieces in rank order", () => {
    const tokenizer = miniTokenizer();
    const ids = tokenizer.encode(" hello world");
    expect(ids.map((id) => tokenizer.tokenOf(id))).toEqual(["Ġhello", "Ġwo", "r", "l", "d"]);
  });

  it("round-trips text, multi-byte characters included", () => {
    const tokenizer = miniTokenizer();
    for (const text of [" hello world", "useState() in App.tsx", "café — naïve 日本"]) {
      expect(tokenizer.decode(tokenizer.encode(text))).toBe(text);
    }
  });

  it("skips special tokens and timestamps when decoding", () => {
    const tokenizer = miniTokenizer();
    const hello = tokenizer.encode(" hello");
    expect(tokenizer.decode([301, 302, ...hello, 302, 300])).toBe(" hello");
    expect(tokenizer.firstSpecialId).toBe(300);
  });

  it("looks up special tokens by text", () => {
    const tokenizer = miniTokenizer();
    expect(tokenizer.idOf("<|startoftranscript|>")).toBe(301);
    expect(tokenizer.idOf("<|fr|>")).toBeUndefined();
  });
});
