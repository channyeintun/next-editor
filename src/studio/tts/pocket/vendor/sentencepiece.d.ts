/** Types for the vendored sentencepiece-js browser build (see sentencepiece.js header). */
export class SentencePieceProcessor {
  loadFromB64StringModel(base64Model: string): Promise<void>;
  encodeIds(text: string): number[];
  decodeIds(ids: number[]): string;
}
