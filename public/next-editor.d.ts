/** Exported memory */
export declare const memory: WebAssembly.Memory;
/**
 * src/core/assembly/index/findCommonPrefix
 * @param str1Ptr `usize`
 * @param str1Len `i32`
 * @param str2Ptr `usize`
 * @param str2Len `i32`
 * @returns `i32`
 */
export declare function findCommonPrefix(str1Ptr: number, str1Len: number, str2Ptr: number, str2Len: number): number;
/**
 * src/core/assembly/index/findCommonSuffix
 * @param str1Ptr `usize`
 * @param str1Len `i32`
 * @param str2Ptr `usize`
 * @param str2Len `i32`
 * @returns `i32`
 */
export declare function findCommonSuffix(str1Ptr: number, str1Len: number, str2Ptr: number, str2Len: number): number;
