import type { Recording } from '../use-scrimba/src';
import { decodeDataFromCanvas } from '../use-scrimba/src/utils/steganography';
import { decodeDataFromVideo } from '../use-scrimba/src/utils/video-steganography';

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
                    resolve(processParsedData(parsed));
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

/**
 * Extracts Scrimba recordings from a Video file using steganography
 */
export async function extractRecordingsFromVideo(file: File): Promise<Recording[]> {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.autoplay = false;
        video.preload = 'auto'; // Add preload
        
        // Wait for video to be fully loaded and seekable
        video.onloadeddata = async () => {
            try {
                // Ensure video is seekable
                if (!video.seekable || video.seekable.length === 0) {
                    throw new Error('Video is not seekable');
                }

                // Wait a bit more for video to be fully ready
                await new Promise(r => setTimeout(r, 100));

                const decodedData = await decodeDataFromVideo(video);
                if (!decodedData) {
                    reject(new Error('No Scrimba data found in video'));
                    return;
                }

                const parsed = JSON.parse(decodedData);
                resolve(processParsedData(parsed));
            } catch (error) {
                reject(new Error(`Failed to decode Scrimba data: ${error instanceof Error ? error.message : 'Unknown error'}`));
            } finally {
                URL.revokeObjectURL(video.src);
            }
        };

        video.onerror = (e) => {
            URL.revokeObjectURL(video.src);
            console.error('Video error:', e);
            reject(new Error('Failed to load video'));
        };

        const url = URL.createObjectURL(file);
        video.src = url;
        
        // Fallback timeout
        setTimeout(() => {
            if (video.readyState < 2) {
                URL.revokeObjectURL(url);
                reject(new Error('Video load timeout'));
            }
        }, 30000); // 30 second timeout
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processParsedData(parsed: any): Recording[] {
    interface ScrimbaImportData extends Recording {
        audioBase64?: string;
    }

    // Handle both single recording and array of recordings
    const parsedArray = Array.isArray(parsed) ? parsed : [parsed];
    const recordings = parsedArray as ScrimbaImportData[];

    // Convert audioBase64 back to audioBlob if present
    return recordings.map((r) => {
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
}
