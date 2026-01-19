import type { Recording } from '../core/src';
import { decodeDataFromCanvas, extractPngMetadata, handleDecodedMessage } from '../core/src/utils/steganography';

/**
 * Extracts recordings from a PNG file using steganography
 */
export async function extractRecordingsFromPng(file: File): Promise<Recording[]> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const img = new Image();
            img.onload = async () => {
                try {
                    // 1. Try to extract from PNG metadata chunks FIRST (100% reliable)
                    const arrayBuffer = await file.arrayBuffer();
                    const metadata = extractPngMetadata(new Uint8Array(arrayBuffer), 'NEXT_EDITOR_v2_DATA');

                    let decodedData: string | null = null;
                    if (metadata) {
                        console.warn('Steganography: Successfully extracted data from PNG metadata chunk.');
                        decodedData = handleDecodedMessage(metadata);
                    } else {
                        console.warn('Steganography: No PNG metadata chunk found. Falling back to canvas LSB decoding.');
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d', {
                            colorSpace: 'srgb',
                            willReadFrequently: true
                        });
                        if (!ctx) {
                            reject(new Error('Could not get canvas context'));
                            return;
                        }
                        ctx.imageSmoothingEnabled = false;
                        ctx.drawImage(img, 0, 0);
                        decodedData = await decodeDataFromCanvas(canvas);
                    }

                    if (!decodedData) {
                        reject(new Error('No data found in image'));
                        return;
                    }

                    const parsed = JSON.parse(decodedData);

                    interface ImportData extends Recording {
                        audioBase64?: string;
                    }

                    // Handle both single recording and array of recordings
                    const parsedArray = Array.isArray(parsed) ? parsed : [parsed];
                    const recordings = parsedArray as ImportData[];

                    // Convert audioBase64 back to audioBlob if present
                    const processedRecordings = recordings.map((r) => {
                        if (r.audioBase64) {
                            const [header, base64] = r.audioBase64.split(',');
                            const mime = header.match(/:(.*?);/)?.[1] || 'audio/webm';
                            const binary = atob(base64);
                            const array = new Uint8Array(binary.length);
                            for (let i = 0; i < binary.length; i++) {
                                array[i] = binary.charCodeAt(i);
                            }
                            return {
                                ...r,
                                audioBlob: new Blob([array], { type: mime }),
                                audioBase64: undefined
                            };
                        }
                        return r;
                    });

                    resolve(processedRecordings);
                } catch (error) {
                    reject(new Error(`Failed to decode data: ${error instanceof Error ? error.message : 'Unknown error'}`));
                }
            };
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = e.target?.result as string;
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}
