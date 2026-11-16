// Types for the npm `punycode` package (it ships none), imported as "punycode/".
declare module "punycode/" {
  interface Ucs2 {
    decode(string: string): number[];
    encode(codePoints: readonly number[]): string;
  }
  interface Punycode {
    version: string;
    ucs2: Ucs2;
    decode(input: string): string;
    encode(input: string): string;
    toASCII(input: string): string;
    toUnicode(input: string): string;
  }
  const punycode: Punycode;
  export default punycode;
}
