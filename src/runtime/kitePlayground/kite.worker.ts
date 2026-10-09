import { expose } from "comlink";
import { kiteOperations } from "./operations";

// The Kite compiler, off the main thread. A Kite program runs inside one
// synchronous Wasm call, so a program that never returns would hang the page
// for good; here it hangs only this worker, which the client terminates when a
// newer Run, a cancel or an unmount takes over.
expose(kiteOperations);
