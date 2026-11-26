import { expose } from "comlink";
import { createPythonOperations } from "./operations";

/** Where the app serves the interpreter's files (build/pyodideAssetsPlugin.ts). */
declare const __PYODIDE_INDEX_URL__: string;

// One Python interpreter, off the main thread. A program runs inside one
// WebAssembly call that returns only when the program does, so a loop that
// never ends would hang the page for good; here it hangs only this worker,
// which the client terminates when a newer Run, a cancel or an unmount takes
// over. The client also ends it after every run, so each program starts in an
// interpreter no other program has touched.
expose(createPythonOperations({ indexURL: __PYODIDE_INDEX_URL__ }));
