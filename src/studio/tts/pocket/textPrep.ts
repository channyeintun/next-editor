/**
 * Text preparation + chunking for pocket-tts generation, ported from the
 * pocket-tts-web demo (Apache-2.0, KevinAHM/pocket-tts-web@d0c0c79). The
 * tokenizer is injected so this stays pure and testable.
 */

export interface PocketTokenizer {
  encodeIds(text: string): number[];
  decodeIds(ids: number[]): string;
}

export interface PocketTextPrepOptions {
  removeSemicolons: boolean;
  padWithSpacesForShortInputs: boolean;
  recommendedFramesAfterEos: number | null;
  maxTokenPerChunk: number;
}

export interface PreparedPrompt {
  text: string;
  framesAfterEos: number;
}

export function prepareTextPrompt(text: string, options: PocketTextPrepOptions): PreparedPrompt {
  let prompt = text.trim();
  if (!prompt) {
    return { text: "", framesAfterEos: 1 };
  }

  prompt = prompt.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ");
  if (options.removeSemicolons) {
    prompt = prompt.replace(/;/g, ",");
  }

  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  let framesAfterEos = wordCount <= 4 ? 3 : 1;
  if (options.recommendedFramesAfterEos != null) {
    framesAfterEos = Number(options.recommendedFramesAfterEos);
  }

  if (prompt && !/[A-ZÀ-Þ]/.test(prompt[0])) {
    prompt = prompt[0].toUpperCase() + prompt.slice(1);
  }
  if (prompt && /[0-9A-Za-zÀ-ÿ]/.test(prompt[prompt.length - 1])) {
    prompt += ".";
  }
  if (options.padWithSpacesForShortInputs && wordCount < 5) {
    prompt = "        " + prompt;
  }

  return { text: prompt, framesAfterEos };
}

const SENTENCE_SPLIT_RE = /[^.!?]+[.!?]+|[^.!?]+$/g;

function splitTextIntoSentences(text: string): string[] {
  const matches = text.match(SENTENCE_SPLIT_RE);
  if (!matches) return [];
  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function splitTokenIdsIntoChunks(
  tokenizer: PocketTokenizer,
  tokenIds: number[],
  maxTokens: number,
): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < tokenIds.length; i += maxTokens) {
    const chunkText = tokenizer.decodeIds(tokenIds.slice(i, i + maxTokens)).trim();
    if (chunkText) {
      chunks.push(chunkText);
    }
  }
  return chunks;
}

export interface ChunkedPrompt {
  chunks: string[];
  framesAfterEos: number;
}

/** Sentence-first chunking bounded by the bundle's token budget per chunk. */
export function splitIntoBestSentences(
  text: string,
  tokenizer: PocketTokenizer,
  options: PocketTextPrepOptions,
): ChunkedPrompt {
  const prepared = prepareTextPrompt(text, options);
  if (!prepared.text) {
    return { chunks: [], framesAfterEos: prepared.framesAfterEos };
  }

  const sentences = splitTextIntoSentences(prepared.text);
  if (!sentences.length) {
    return { chunks: [prepared.text], framesAfterEos: prepared.framesAfterEos };
  }

  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentenceText of sentences) {
    const sentenceTokenIds = tokenizer.encodeIds(sentenceText);

    if (sentenceTokenIds.length > options.maxTokenPerChunk) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      chunks.push(
        ...splitTokenIdsIntoChunks(tokenizer, sentenceTokenIds, options.maxTokenPerChunk),
      );
      continue;
    }

    if (!currentChunk) {
      currentChunk = sentenceText;
      continue;
    }

    const combined = `${currentChunk} ${sentenceText}`;
    if (tokenizer.encodeIds(combined).length > options.maxTokenPerChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = sentenceText;
    } else {
      currentChunk = combined;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return { chunks, framesAfterEos: prepared.framesAfterEos };
}
