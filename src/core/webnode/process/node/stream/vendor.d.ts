// The readable-stream entry webnode imports. `lib/stream.js` is Node's own
// stream module extracted (readable-stream@4.8.0); stream.ts casts it to the
// shape in stream/types.ts. Importing it (not the package main) skips the
// main's `require("stream")`.
declare module "readable-stream/lib/stream.js" {
  const Stream: unknown;
  export default Stream;
}
