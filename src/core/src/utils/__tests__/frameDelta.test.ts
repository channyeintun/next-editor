import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
    applyContentDelta,
    compressFrames,
    createContentDelta,
    findCommonPrefixLength,
    findCommonSuffixLength,
    reconstructFrameAtIndex,
} from '../frameDelta';
import { isKeyframe, isDelta } from '../deltaTypes';
import { initWasm, isWasmInitialized } from '../wasm';
import type { EditorFrame } from '../../types';

describe('Delta Compression Optimization', () => {
    beforeAll(async () => {
        if (isWasmInitialized()) return;

        const wasmBytes = await readFile(
            `${process.cwd()}/public/next-editor.wasm`,
        );
        const originalFetch = globalThis.fetch;

        globalThis.fetch = (async () => {
            return new Response(wasmBytes, {
                headers: {
                    'Content-Type': 'application/wasm',
                },
            });
        }) as typeof fetch;

        try {
            expect(await initWasm('/next-editor.wasm')).toBe(true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    const createMockFrame = (content: string, timestamp: number): EditorFrame => ({
        timestamp,
        state: {
            content,
            selection: {
                startLineNumber: 1,
                startColumn: 1,
                endLineNumber: 1,
                endColumn: 1,
                selectionStartLineNumber: 1,
                selectionStartColumn: 1,
                positionLineNumber: 1,
                positionColumn: 1,
            },
            position: { lineNumber: 1, column: 1 },
            viewState: null,
            mouseCursor: { x: 0, y: 0, visible: false },
        },
    });

    it('should skip frames with no changes', () => {
        const fullFrames: EditorFrame[] = [
            createMockFrame('hello', 0),
            createMockFrame('hello', 100), // No change
            createMockFrame('hello', 200), // No change
            createMockFrame('hello world', 300), // Change
            createMockFrame('hello world', 400), // No change
        ];

        const compressed = compressFrames(fullFrames);

        // Should only have:
        // 1. Initial keyframe (t=0)
        // 2. Delta (t=300)
        expect(compressed.length).toBe(2);
        expect(compressed[0].timestamp).toBe(0);
        expect(isKeyframe(compressed[0])).toBe(true);
        expect(compressed[1].timestamp).toBe(300);
        expect(isDelta(compressed[1])).toBe(true);
    });

    it('should still create keyframes at regular intervals if there are changes', () => {
        // Assuming KEYFRAME_INTERVAL is 120
        const fullFrames: EditorFrame[] = [];
        for (let i = 0; i <= 125; i++) {
            fullFrames.push(createMockFrame(`content ${i}`, i * 100));
        }

        const compressed = compressFrames(fullFrames);

        // Index 0: Keyframe
        // Index 120: Keyframe
        // Others: Deltas
        expect(isKeyframe(compressed[0])).toBe(true);

        // Find the frame that corresponds to original index 120
        const frameAt120 = compressed.find(f => f.timestamp === 12000);
        expect(frameAt120).toBeDefined();
        expect(isKeyframe(frameAt120!)).toBe(true);
    });

    it('should skip keyframe slots if there are no changes', () => {
        const fullFrames: EditorFrame[] = [];
        for (let i = 0; i <= 125; i++) {
            // Only change at index 125
            const content = (i === 125) ? `change` : 'initial';
            fullFrames.push(createMockFrame(content, i * 100));
        }

        const compressed = compressFrames(fullFrames);

        // Index 0: 'initial' (Keyframe)
        // Index 120: 'initial' (No change -> skipped)
        // Index 125: 'change' (Delta)
        expect(compressed.length).toBe(2);
        expect(compressed[0].timestamp).toBe(0);
        expect(compressed[1].timestamp).toBe(12500);
    });

    it('should reconstruct frames correctly from sparse data', () => {
        const fullFrames: EditorFrame[] = [
            createMockFrame('a', 0),
            createMockFrame('a', 100),
            createMockFrame('ab', 200),
            createMockFrame('ab', 300),
            createMockFrame('abc', 400),
        ];

        const compressed = compressFrames(fullFrames);
        // Compressed should be: [Key(a, 0), Delta(ab, 200), Delta(abc, 400)]

        const reconstructed200 = reconstructFrameAtIndex(compressed, 1);
        expect(reconstructed200?.state.content).toBe('ab');

        const reconstructed400 = reconstructFrameAtIndex(compressed, 2);
        expect(reconstructed400?.state.content).toBe('abc');
    });

    it('should not treat a shared UTF-8 lead byte as a shared character prefix', () => {
        expect(findCommonPrefixLength('éx', 'èy')).toBe(0);

        const delta = createContentDelta('éx', 'èy');
        expect(delta).toEqual({
            prefixLen: 0,
            suffixLen: 0,
            insert: 'èy',
        });
        expect(applyContentDelta('éx', delta!)).toBe('èy');
    });

    it('should preserve suffix characters when the differing character is multi-byte', () => {
        expect(findCommonSuffixLength('éa', 'ĩa')).toBe(1);

        const delta = createContentDelta('éa', 'ĩa');
        expect(delta).toEqual({
            prefixLen: 0,
            suffixLen: 1,
            insert: 'ĩ',
        });
        expect(applyContentDelta('éa', delta!)).toBe('ĩa');
    });
});
