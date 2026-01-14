import type { Recording } from '../use-scrimba/src';
import { decodeDataFromCanvas } from '../use-scrimba/src/utils/steganography';

/**
 * Extracts Scrimba recordings from a PNG file using steganography
 */
export async function extractRecordingsFromPng(file: File): Promise<Recording[]> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('Could not get canvas context'));
                    return;
                }
                ctx.drawImage(img, 0, 0);

                try {
                    const decodedData = decodeDataFromCanvas(canvas);
                    if (!decodedData) {
                        reject(new Error('No Scrimba data found in image'));
                        return;
                    }

                    const parsed = JSON.parse(decodedData);

                    interface ScrimbaImportData extends Recording {
                        audioBase64?: string;
                    }

                    // Handle both single recording and array of recordings
                    const parsedArray = Array.isArray(parsed) ? parsed : [parsed];
                    const recordings = parsedArray as ScrimbaImportData[];

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
                    reject(new Error(`Failed to decode Scrimba data: ${error instanceof Error ? error.message : 'Unknown error'}`));
                }
            };
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = e.target?.result as string;
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}
