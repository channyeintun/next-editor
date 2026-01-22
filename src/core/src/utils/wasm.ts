
let wasmInstance: WebAssembly.Instance | null = null;
let wasmPromise: Promise<WebAssembly.Instance | null> | null = null;

export interface WasmExports {
    memory: WebAssembly.Memory;
    __heap_base?: WebAssembly.Global; // AssemblyScript heap start
    findCommonPrefix(str1Ptr: number, str1Len: number, str2Ptr: number, str2Len: number): number;
    findCommonSuffix(str1Ptr: number, str1Len: number, str2Ptr: number, str2Len: number): number;
}

/**
 * Initializes the WebAssembly module.
 * 
 * Performance Note:
 * This module uses WebAssembly to optimize string diffing operations
 * which involves iterating over large strings, significantly faster in Wasm.
 * 
 * @param url The URL to the .wasm file. If not provided, it defaults to '/next-editor.wasm'.
 */
export async function initWasm(url?: string): Promise<boolean> {
    if (wasmInstance) return true;
    if (wasmPromise) return (await wasmPromise) !== null;

    wasmPromise = (async () => {
        try {
            // Default URL if not provided.
            const wasmUrl = url || '/next-editor.wasm';

            let response: Response;
            try {
                response = await fetch(wasmUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
            } catch (err) {
                console.warn(`Failed to fetch wasm from ${wasmUrl}:`, err);
                console.warn('Performance optimizations will be disabled.');
                return null;
            }

            const module = await WebAssembly.compileStreaming(response);
            const instance = await WebAssembly.instantiate(module, {
                env: {
                    abort: () => console.error('Wasm aborted')
                }
            });
            wasmInstance = instance;
            console.log('WebAssembly Diffing module initialized from', wasmUrl);
            return instance;
        } catch (e) {
            console.error('Failed to initialize WebAssembly optimized diffing', e);
            return null;
        }
    })();

    return (await wasmPromise) !== null;
}

/**
 * Gets the Wasm exports if available.
 */
export function getWasmExports(): WasmExports | null {
    if (!wasmInstance) return null;
    return wasmInstance.exports as unknown as WasmExports;
}

/**
 * Checks if Wasm is initialized.
 */
export function isWasmInitialized(): boolean {
    return wasmInstance !== null;
}
