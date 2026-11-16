// Types for the npm `string_decoder` package (it ships none), imported as
// "string_decoder/".
declare module "string_decoder/" {
  /** Decodes byte chunks into strings without splitting multi-byte characters. */
  export class StringDecoder {
    constructor(encoding?: string);
    readonly encoding: string;
    lastChar: Uint8Array;
    lastNeed: number;
    lastTotal: number;
    write(buffer: Uint8Array | string): string;
    end(buffer?: Uint8Array | string): string;
    text(buffer: Uint8Array, offset: number): string;
  }
}
